import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { describe, expect, test, vi } from "vitest";

import { AuthenticationError } from "../../src/errors.js";
import { GraphClient } from "../../src/graph-client.js";
import { RateLimiter } from "../../src/rate-limiter.js";
import { DRIVE_ITEM_FIELDS, registerFilesTools } from "../../src/tools/files-tools.js";
import type { ToolDependencies } from "../../src/tools/tool-types.js";

type RecordedCallback = (args: unknown, extra: unknown) => CallToolResult | Promise<CallToolResult>;

interface RecordedToolConfig {
  readonly description?: string;
  readonly inputSchema?: ZodRawShape;
}

interface RecordedRegistration {
  readonly name: string;
  readonly config: RecordedToolConfig;
  readonly callback: RecordedCallback;
}

interface GraphCall {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly path: string;
  readonly params?: unknown;
  readonly body?: unknown;
  readonly data?: Uint8Array;
  readonly jsonBody?: unknown;
  readonly headers?: unknown;
}

interface GraphFake {
  readonly graphClient: ToolDependencies["graphClient"];
  readonly calls: GraphCall[];
}

interface ToolHarness {
  readonly server: Pick<McpServer, "registerTool">;
  readonly registrations: RecordedRegistration[];
  registration(name: string): RecordedRegistration;
  invoke(name: string, args?: unknown): Promise<CallToolResult>;
  invokeRaw(name: string, args: unknown): Promise<CallToolResult>;
}

const FILE_METADATA_FIELDS = "id,name,size,file,@microsoft.graph.downloadUrl";
const BINARY_NOTE = "Binary file — use the downloadUrl to access content.";
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_STANDARD_BASE64_LENGTH = 4 * Math.ceil(MAX_UPLOAD_BYTES / 3);

const EXPECTED_FILE_TOOLS = [
  {
    name: "graph_list_files",
    description: `List files and folders in OneDrive.

Args:
    folder_id: Folder ID to list contents of. Empty for root folder.
    top: Maximum number of items to return (default 25).`,
  },
  {
    name: "graph_search_files",
    description: `Search for files in OneDrive by name or content.

Args:
    query: Search query string.
    top: Maximum number of results (default 25).`,
  },
  {
    name: "graph_get_file_content",
    description: `Get the content of a file from OneDrive.

For text-based files (txt, csv, json, etc.), returns the file content
directly. For binary files (images, docx, pdf, etc.), returns a
temporary download URL instead.

Args:
    file_id: The file ID (from graph_list_files or graph_search_files).`,
  },
  {
    name: "graph_upload_file",
    description: `Upload a small file to OneDrive (max 4MB).

Args:
    file_path: Destination path in OneDrive (e.g. "Documents/report.txt").
    content_base64: File content encoded as base64 string.`,
  },
  {
    name: "graph_share_file",
    description: `Create a sharing link for a OneDrive file.

Args:
    file_id: The file ID to share.
    share_type: Permission type: "view", "edit", or "embed" (default "view").
    scope: Share scope: "anonymous", "organization", or "users" (default "organization").`,
  },
] as const;

const INVALID_GRAPH_RESPONSE_RESULT = {
  content: [
    {
      type: "text",
      text: '{"error":"Graph API error: Invalid Microsoft Graph response."}',
    },
  ],
} as const;

const AUTHENTICATION_ERROR_RESULT = {
  content: [
    {
      type: "text",
      text: '{"error":"Not authenticated.","action_required":"Please call the graph_auth_login tool first."}',
    },
  ],
} as const;

const INVALID_BASE64_RESULT = {
  content: [
    {
      type: "text",
      text: '{"error":"Unexpected error: Invalid base64 content."}',
    },
  ],
} as const;

function nextGraphResponse(responses: unknown[]): unknown {
  if (responses.length === 0) {
    throw new Error("No fake Graph response was configured.");
  }
  const response = responses.shift();
  if (response instanceof Error) {
    throw response;
  }
  return response;
}

function createGraphFake(initialResponses: readonly unknown[] = []): GraphFake {
  const responses = [...initialResponses];
  const calls: GraphCall[] = [];
  const graphClient: ToolDependencies["graphClient"] = {
    get: (path, params, headers) => {
      calls.push({
        method: "GET",
        path,
        ...(params === undefined ? {} : { params }),
        ...(headers === undefined ? {} : { headers }),
      });
      return Promise.resolve(nextGraphResponse(responses));
    },
    post: (path, body, params, headers) => {
      calls.push({
        method: "POST",
        path,
        ...(body === undefined ? {} : { body }),
        ...(params === undefined ? {} : { params }),
        ...(headers === undefined ? {} : { headers }),
      });
      return Promise.resolve(nextGraphResponse(responses));
    },
    patch: (path, body, headers) => {
      calls.push({
        method: "PATCH",
        path,
        ...(body === undefined ? {} : { body }),
        ...(headers === undefined ? {} : { headers }),
      });
      return Promise.resolve(nextGraphResponse(responses));
    },
    put: (path, data, jsonBody, headers) => {
      calls.push({
        method: "PUT",
        path,
        ...(data === undefined ? {} : { data }),
        ...(jsonBody === undefined ? {} : { jsonBody }),
        ...(headers === undefined ? {} : { headers }),
      });
      return Promise.resolve(nextGraphResponse(responses));
    },
    delete: (path, headers) => {
      calls.push({
        method: "DELETE",
        path,
        ...(headers === undefined ? {} : { headers }),
      });
      return Promise.resolve(nextGraphResponse(responses));
    },
  };

  return { graphClient, calls };
}

function createToolHarness(): ToolHarness {
  const registrations: RecordedRegistration[] = [];
  const registerTool = ((name: string, config: unknown, callback: unknown) => {
    if (typeof callback !== "function") {
      throw new Error("Expected a registered callback.");
    }
    registrations.push({
      name,
      config: config as RecordedToolConfig,
      callback: callback as RecordedCallback,
    });
    return {} as RegisteredTool;
  }) as McpServer["registerTool"];

  return {
    server: { registerTool },
    registrations,
    registration(name) {
      const registration = registrations.find((candidate) => candidate.name === name);
      if (registration === undefined) {
        throw new Error(`Tool ${name} was not registered.`);
      }
      return registration;
    },
    async invoke(name, args = {}) {
      const registration = this.registration(name);
      const parsedArgs = z.object(registration.config.inputSchema ?? {}).parse(args);
      return await registration.callback(parsedArgs, {});
    },
    async invokeRaw(name, args) {
      return await this.registration(name).callback(args, {});
    },
  };
}

function schemaFor(harness: ToolHarness, name: string): ZodRawShape {
  const schema = harness.registration(name).config.inputSchema;
  if (schema === undefined) {
    throw new Error(`Tool ${name} did not expose an input schema.`);
  }
  return schema;
}

function dataFrom(result: CallToolResult): unknown {
  const content = result.content[0];
  if (content?.type !== "text") {
    throw new Error("Expected a text tool result.");
  }
  const payload: unknown = JSON.parse(content.text);
  if (typeof payload !== "object" || payload === null || !("data" in payload)) {
    throw new Error("Expected a success response.");
  }
  return payload.data;
}

function authManager(): ToolDependencies["authManager"] {
  return {
    getStatus: () => ({ state: "unauthenticated" }),
    login: () => Promise.resolve({ state: "authenticated" }),
    logout: () => Promise.resolve(),
    getValidAccessToken: () => Promise.resolve("access-token"),
    refreshAccessToken: () => Promise.resolve(true),
  };
}

function registerFilesHarness(graphResponses: readonly unknown[] = []): {
  readonly harness: ToolHarness;
  readonly graph: GraphFake;
} {
  const harness = createToolHarness();
  const graph = createGraphFake(graphResponses);
  registerFilesTools(harness.server, {
    authManager: authManager(),
    graphClient: graph.graphClient,
  });
  return { harness, graph };
}

function registerRealGraphFilesHarness(): {
  readonly harness: ToolHarness;
  readonly fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
} {
  const harness = createToolHarness();
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify({ value: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }),
    ),
  );
  const graphClient = new GraphClient({
    authManager: authManager(),
    rateLimiter: new RateLimiter({ maxRequests: 100, windowMs: 1_000 }),
    fetch,
    sleep: () => Promise.resolve(),
    timeoutMs: 1_000,
  });
  registerFilesTools(harness.server, { authManager: authManager(), graphClient });
  return { harness, fetch };
}

function firstRequest(fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>): Request {
  const call = fetch.mock.calls[0];
  if (call === undefined) {
    throw new Error("Expected a Graph fetch call.");
  }
  return new Request(call[0], call[1]);
}

describe("file tool registration", () => {
  test("registers exactly the five legacy file names and complete descriptions", () => {
    const { harness } = registerFilesHarness();

    expect(
      harness.registrations.map(({ name, config }) => ({
        name,
        description: config.description,
      })),
    ).toEqual(EXPECTED_FILE_TOOLS);
  });

  test("exports the exact Python drive item select value", () => {
    expect(DRIVE_ITEM_FIELDS).toBe(
      "id,name,size,createdDateTime,lastModifiedDateTime,file,folder,webUrl,parentReference",
    );
  });

  test("exposes exact public snake_case schemas, defaults, and required fields", () => {
    const { harness } = registerFilesHarness();

    const listShape = schemaFor(harness, "graph_list_files");
    expect(Object.keys(listShape)).toEqual(["folder_id", "top"]);
    const listSchema = z.object(listShape);
    expect(listSchema.parse({})).toEqual({ folder_id: "", top: 25 });
    expect(listSchema.safeParse({ top: 1.5 }).success).toBe(false);
    expect(listSchema.safeParse({ top: -1 }).success).toBe(true);
    expect(listSchema.safeParse({ top: 500 }).success).toBe(true);

    const searchShape = schemaFor(harness, "graph_search_files");
    expect(Object.keys(searchShape)).toEqual(["query", "top"]);
    const searchSchema = z.object(searchShape);
    expect(searchSchema.parse({ query: "planning" })).toEqual({ query: "planning", top: 25 });
    expect(searchSchema.safeParse({}).success).toBe(false);
    expect(searchSchema.safeParse({ query: "planning", top: 2.5 }).success).toBe(false);

    const contentShape = schemaFor(harness, "graph_get_file_content");
    expect(Object.keys(contentShape)).toEqual(["file_id"]);
    expect(z.object(contentShape).safeParse({}).success).toBe(false);

    const uploadShape = schemaFor(harness, "graph_upload_file");
    expect(Object.keys(uploadShape)).toEqual(["file_path", "content_base64"]);
    const uploadSchema = z.object(uploadShape);
    expect(uploadSchema.safeParse({ file_path: "Documents/report.txt" }).success).toBe(false);
    expect(uploadSchema.safeParse({ content_base64: "SGVsbG8=" }).success).toBe(false);

    const shareShape = schemaFor(harness, "graph_share_file");
    expect(Object.keys(shareShape)).toEqual(["file_id", "share_type", "scope"]);
    expect(z.object(shareShape).parse({ file_id: "file-1" })).toEqual({
      file_id: "file-1",
      share_type: "view",
      scope: "organization",
    });
  });

  test("allows the empty folder sentinel and rejects dot-sentinel resource IDs", () => {
    const { harness } = registerFilesHarness();
    const listSchema = z.object(schemaFor(harness, "graph_list_files"));
    expect(listSchema.safeParse({ folder_id: "" }).success).toBe(true);
    expect(listSchema.safeParse({ folder_id: "folder/child" }).success).toBe(true);
    expect(listSchema.safeParse({ folder_id: "." }).success).toBe(false);
    expect(listSchema.safeParse({ folder_id: ".." }).success).toBe(false);

    for (const name of ["graph_get_file_content", "graph_share_file"]) {
      const schema = z.object(schemaFor(harness, name));
      for (const fileId of ["", ".", ".."]) {
        expect(schema.safeParse({ file_id: fileId }).success).toBe(false);
      }
    }
  });
});

describe("OneDrive list and search operations", () => {
  test("lists root children with exact select and default top", async () => {
    const { harness, graph } = registerFilesHarness([{ value: [{ id: "file-1" }] }]);

    expect(dataFrom(await harness.invoke("graph_list_files"))).toEqual([{ id: "file-1" }]);
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/drive/root/children",
        params: { $select: DRIVE_ITEM_FIELDS, $top: "25" },
      },
    ]);
  });

  test("lists an encoded folder item and caps top at 50 in the handler", async () => {
    const folderId = "../folder/path\\name#fragment?query=:value%";
    const { harness, graph } = registerFilesHarness([{ value: [] }, { value: [] }]);

    await harness.invoke("graph_list_files", { folder_id: folderId, top: 500 });
    await harness.invoke("graph_list_files", { folder_id: "folder-2", top: -2 });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: `/me/drive/items/${encodeURIComponent(folderId)}/children`,
        params: { $select: DRIVE_ITEM_FIELDS, $top: "50" },
      },
      {
        method: "GET",
        path: "/me/drive/items/folder-2/children",
        params: { $select: DRIVE_ITEM_FIELDS, $top: "-2" },
      },
    ]);
  });

  test("preserves normal search expressions, doubles OData quotes, and caps top at 25", async () => {
    const { harness, graph } = registerFilesHarness([{ value: [] }, { value: [] }]);

    await harness.invoke("graph_search_files", { query: "quarterly report" });
    await harness.invoke("graph_search_files", { query: "O'Brien report", top: 500 });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/drive/root/search(q='quarterly report')",
        params: { $select: DRIVE_ITEM_FIELDS, $top: "25" },
      },
      {
        method: "GET",
        path: "/me/drive/root/search(q='O''Brien report')",
        params: { $select: DRIVE_ITEM_FIELDS, $top: "25" },
      },
    ]);
  });

  test("contains path, query, fragment, percent, and quote injection through real URL semantics", async () => {
    const query = "budget')/children?x=1#fragment%2Fescape\\more";
    const { harness, fetch } = registerRealGraphFilesHarness();

    expect(dataFrom(await harness.invoke("graph_search_files", { query }))).toEqual([]);

    const request = firstRequest(fetch);
    const url = new URL(request.url);
    expect(request.method).toBe("GET");
    expect(url.origin).toBe("https://graph.microsoft.com");
    expect(url.pathname).toBe(
      "/v1.0/me/drive/root/search(q='budget'')%2Fchildren%3Fx=1%23fragment%252Fescape%5Cmore')",
    );
    expect(url.searchParams.get("$select")).toBe(DRIVE_ITEM_FIELDS);
    expect(url.searchParams.get("$top")).toBe("25");
    expect([...url.searchParams.keys()].sort()).toEqual(["$select", "$top"]);
    expect(url.hash).toBe("");
    expect(url.pathname.split("/")).toHaveLength(6);
  });

  test.each([
    { name: "graph_list_files", args: {} },
    { name: "graph_search_files", args: { query: "planning" } },
  ])("$name treats a missing value property as an empty list", async ({ name, args }) => {
    const { harness } = registerFilesHarness([{}]);
    expect(dataFrom(await harness.invoke(name, args))).toEqual([]);
  });

  test.each([
    { name: "graph_list_files", args: {} },
    { name: "graph_search_files", args: { query: "planning" } },
  ])("$name rejects malformed collection responses without leakage", async ({ name, args }) => {
    for (const response of [null, [], "payload-secret", { value: null }, { value: {} }]) {
      const { harness } = registerFilesHarness([response]);
      const result = await harness.invoke(name, args);

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(JSON.stringify(result)).not.toContain("payload-secret");
      expect(JSON.stringify(result)).not.toContain("TypeError");
    }
  });
});

describe("OneDrive file content routing", () => {
  test.each([
    "text/plain",
    "text/csv",
    "application/json",
    "application/xml",
    "application/javascript",
    "application/csv",
  ])("fetches %s content as text from the exact encoded path", async (mimeType) => {
    const fileId = "../file/path\\name#fragment?query=:value%";
    const metadata = { id: fileId, name: "report.txt", file: { mimeType } };
    const { harness, graph } = registerFilesHarness([metadata, "file content"]);

    expect(dataFrom(await harness.invoke("graph_get_file_content", { file_id: fileId }))).toEqual({
      name: "report.txt",
      mimeType,
      content: "file content",
    });
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: `/me/drive/items/${encodeURIComponent(fileId)}`,
        params: { $select: FILE_METADATA_FIELDS },
      },
      {
        method: "GET",
        path: `/me/drive/items/${encodeURIComponent(fileId)}/content`,
      },
    ]);
  });

  test("returns binary metadata, URL, and the exact note without fetching content", async () => {
    const metadata = {
      id: "file-1",
      name: "report.pdf",
      size: 1234,
      file: { mimeType: "application/pdf" },
      "@microsoft.graph.downloadUrl": "https://download.example/temporary",
    };
    const { harness, graph } = registerFilesHarness([metadata]);

    expect(dataFrom(await harness.invoke("graph_get_file_content", { file_id: "file-1" }))).toEqual(
      {
        name: "report.pdf",
        mimeType: "application/pdf",
        size: 1234,
        downloadUrl: "https://download.example/temporary",
        note: BINARY_NOTE,
      },
    );
    expect(graph.calls).toHaveLength(1);
  });

  test("preserves Python missing-field defaults for binary and text metadata", async () => {
    const { harness } = registerFilesHarness([{}, { file: { mimeType: "text/plain" } }, "hello"]);

    expect(
      dataFrom(await harness.invoke("graph_get_file_content", { file_id: "binary-file" })),
    ).toEqual({
      name: null,
      mimeType: "",
      size: null,
      downloadUrl: "",
      note: BINARY_NOTE,
    });
    expect(
      dataFrom(await harness.invoke("graph_get_file_content", { file_id: "text-file" })),
    ).toEqual({ name: null, mimeType: "text/plain", content: "hello" });
  });

  test.each([null, [], "payload-secret", 42])(
    "rejects malformed file metadata %# without leakage",
    async (response) => {
      const { harness, graph } = registerFilesHarness([response]);
      const result = await harness.invoke("graph_get_file_content", { file_id: "file-1" });

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(graph.calls).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("payload-secret");
      expect(JSON.stringify(result)).not.toContain("TypeError");
    },
  );

  test.each([
    { file: null },
    { file: [] },
    { file: "payload-secret" },
    { file: { mimeType: null } },
    { file: { mimeType: 42 } },
  ])("rejects malformed nested file metadata %# without fetching content", async (response) => {
    const { harness, graph } = registerFilesHarness([response]);
    const result = await harness.invoke("graph_get_file_content", { file_id: "file-1" });

    expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
    expect(graph.calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("payload-secret");
    expect(JSON.stringify(result)).not.toContain("TypeError");
  });

  test.each([null, [], {}, 42, { secret: "payload-secret" }])(
    "rejects malformed text content %# without leakage",
    async (response) => {
      const { harness, graph } = registerFilesHarness([
        { name: "report.txt", file: { mimeType: "text/plain" } },
        response,
      ]);
      const result = await harness.invoke("graph_get_file_content", { file_id: "file-1" });

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(graph.calls).toHaveLength(2);
      expect(JSON.stringify(result)).not.toContain("payload-secret");
      expect(JSON.stringify(result)).not.toContain("TypeError");
    },
  );
});

describe("OneDrive uploads", () => {
  test("uploads decoded bytes with exact segment encoding, argument order, and content type", async () => {
    const filePath = "Documents/Quarterly #1?/report%2e.txt";
    const contentBase64 = "AAEC/f7/";
    const filePathBefore = filePath;
    const contentBefore = contentBase64;
    const uploaded = { id: "file-1", name: "report.txt" };
    const { harness, graph } = registerFilesHarness([uploaded]);

    expect(
      dataFrom(
        await harness.invokeRaw("graph_upload_file", {
          file_path: filePath,
          content_base64: contentBase64,
        }),
      ),
    ).toEqual(uploaded);
    expect(filePath).toBe(filePathBefore);
    expect(contentBase64).toBe(contentBefore);
    expect(graph.calls).toHaveLength(1);
    expect(graph.calls[0]).toMatchObject({
      method: "PUT",
      path: "/me/drive/root:/Documents/Quarterly%20%231%3F/report%252e.txt:/content",
      headers: { "Content-Type": "application/octet-stream" },
    });
    expect(graph.calls[0]).not.toHaveProperty("jsonBody");
    expect(graph.calls[0]?.data).toBeInstanceOf(Uint8Array);
    expect([...new Uint8Array(graph.calls[0]?.data ?? [])]).toEqual([0, 1, 2, 253, 254, 255]);
  });

  test("accepts canonical unpadded standard base64", async () => {
    const { harness, graph } = registerFilesHarness([{ id: "file-1" }]);

    await harness.invoke("graph_upload_file", {
      file_path: "hello.txt",
      content_base64: "SGVsbG8",
    });

    expect(new TextDecoder().decode(graph.calls[0]?.data)).toBe("Hello");
  });

  test.each(["%%%%", "Zm=8", "Zg===", "A", "AB==", "Zg=", "Z g==", "__8=", "payload-secret!"])(
    "rejects malformed or noncanonical base64 %j before upload",
    async (contentBase64) => {
      const { harness, graph } = registerFilesHarness();

      const result = await harness.invoke("graph_upload_file", {
        file_path: "Documents/report.txt",
        content_base64: contentBase64,
      });

      expect(result).toEqual(INVALID_BASE64_RESULT);
      expect(graph.calls).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(contentBase64);
    },
  );

  test("rejects encoded input above the maximum before base64 decoding", async () => {
    const contentBase64 = "A".repeat(MAX_STANDARD_BASE64_LENGTH + 4);
    const { harness, graph } = registerFilesHarness();
    const bufferFrom = vi.spyOn(Buffer, "from");

    try {
      const result = await harness.invoke("graph_upload_file", {
        file_path: "large.bin",
        content_base64: contentBase64,
      });

      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: '{"data":{"error":"File too large. Maximum upload size is 4MB."},"message":"error"}',
          },
        ],
      });
      expect(bufferFrom).not.toHaveBeenCalled();
      expect(graph.calls).toEqual([]);
    } finally {
      bufferFrom.mockRestore();
    }
  });

  test("returns the exact oversize error envelope without calling Graph", async () => {
    const contentBase64 = Buffer.alloc(4 * 1024 * 1024 + 1, 0x61).toString("base64");
    const { harness, graph } = registerFilesHarness();

    const result = await harness.invoke("graph_upload_file", {
      file_path: "large.bin",
      content_base64: contentBase64,
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: '{"data":{"error":"File too large. Maximum upload size is 4MB."},"message":"error"}',
        },
      ],
    });
    expect(graph.calls).toEqual([]);
  });

  test("allows an exact 4 MiB payload", async () => {
    const contentBase64 = Buffer.alloc(4 * 1024 * 1024, 0xa5).toString("base64");
    const { harness, graph } = registerFilesHarness([{ id: "file-1" }]);

    expect(
      dataFrom(
        await harness.invoke("graph_upload_file", {
          file_path: "exact.bin",
          content_base64: contentBase64,
        }),
      ),
    ).toEqual({ id: "file-1" });
    expect(graph.calls).toHaveLength(1);
    expect(graph.calls[0]?.data?.byteLength).toBe(4 * 1024 * 1024);
    expect(graph.calls[0]?.data?.[0]).toBe(0xa5);
    expect(graph.calls[0]?.data?.at(-1)).toBe(0xa5);
  });

  test.each([
    "",
    "/absolute.txt",
    "folder//file.txt",
    "folder/./file.txt",
    "folder/../file.txt",
    "folder/",
  ])("rejects unsafe destination path %j before upload", async (filePath) => {
    const { harness, graph } = registerFilesHarness();

    await expect(
      harness.invoke("graph_upload_file", {
        file_path: filePath,
        content_base64: "SGVsbG8=",
      }),
    ).rejects.toBeInstanceOf(z.ZodError);
    expect(graph.calls).toEqual([]);
  });

  test.each([null, [], "payload-secret", 42])(
    "rejects malformed upload metadata %# without leakage",
    async (response) => {
      const { harness } = registerFilesHarness([response]);
      const result = await harness.invoke("graph_upload_file", {
        file_path: "report.txt",
        content_base64: "SGVsbG8=",
      });

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(JSON.stringify(result)).not.toContain("payload-secret");
      expect(JSON.stringify(result)).not.toContain("TypeError");
    },
  );
});

describe("OneDrive sharing and path safety", () => {
  test("creates default and custom sharing links with exact bodies and full results", async () => {
    const first = { id: "permission-1", link: { type: "view" } };
    const second = { id: "permission-2", link: { type: "edit" } };
    const fileId = "../file/path\\name#fragment?query=:value%";
    const { harness, graph } = registerFilesHarness([first, second]);

    expect(dataFrom(await harness.invoke("graph_share_file", { file_id: fileId }))).toEqual(first);
    expect(
      dataFrom(
        await harness.invoke("graph_share_file", {
          file_id: "file-2",
          share_type: "edit",
          scope: "anonymous",
        }),
      ),
    ).toEqual(second);
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: `/me/drive/items/${encodeURIComponent(fileId)}/createLink`,
        body: { type: "view", scope: "organization" },
      },
      {
        method: "POST",
        path: "/me/drive/items/file-2/createLink",
        body: { type: "edit", scope: "anonymous" },
      },
    ]);
  });

  test.each([null, [], "payload-secret", 42])(
    "rejects malformed share metadata %# without leakage",
    async (response) => {
      const { harness } = registerFilesHarness([response]);
      const result = await harness.invoke("graph_share_file", { file_id: "file-1" });

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(JSON.stringify(result)).not.toContain("payload-secret");
      expect(JSON.stringify(result)).not.toContain("TypeError");
    },
  );
});

describe("file authenticated wrapper errors", () => {
  test.each([
    { name: "graph_list_files", args: {} },
    { name: "graph_search_files", args: { query: "planning" } },
    { name: "graph_get_file_content", args: { file_id: "file-1" } },
    {
      name: "graph_upload_file",
      args: { file_path: "report.txt", content_base64: "SGVsbG8=" },
    },
    { name: "graph_share_file", args: { file_id: "file-1" } },
  ])("$name returns the stable authentication error envelope", async ({ name, args }) => {
    const { harness } = registerFilesHarness([new AuthenticationError("Not authenticated.")]);

    await expect(harness.invoke(name, args)).resolves.toEqual(AUTHENTICATION_ERROR_RESULT);
  });
});
