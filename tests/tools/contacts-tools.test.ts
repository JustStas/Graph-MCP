import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { describe, expect, test } from "vitest";

import { AuthenticationError } from "../../src/errors.js";
import { registerContactsTools } from "../../src/tools/contacts-tools.js";
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
}

const PERSON_FIELDS = "id,displayName,scoredEmailAddresses,jobTitle,companyName,personType";
const CONTACT_FIELDS =
  "id,displayName,emailAddresses,mobilePhone,businessPhones,companyName,jobTitle";

const EXPECTED_CONTACTS_TOOLS = [
  {
    name: "graph_search_people",
    description: `Search people the user works with, ranked by relevance.

Covers colleagues, saved contacts, and external people the user has mailed,
so prefer this over graph_search_users when looking someone up by name.
\`$search\` on /me/people only works for the signed-in user. Requires the
People.Read permission.

Args:
    query: Name, email address, or partial text to look up.
    top: Maximum number of people to return (default 10, maximum 50).`,
  },
  {
    name: "graph_list_contacts",
    description: `List the user's saved Outlook contacts.

Args:
    top: Maximum number of contacts to return (default 25, maximum 50).
    folder_id: Contact folder ID. Empty lists the default contacts folder.`,
  },
  {
    name: "graph_create_contact",
    description: `Create an Outlook contact. Requires the Contacts.ReadWrite permission.

Empty fields are omitted from the created contact.

Args:
    given_name: First name of the contact.
    surname: Last name of the contact.
    email: Primary email address.
    mobile_phone: Mobile phone number.
    company_name: Company the contact works for.
    job_title: Job title of the contact.`,
  },
  {
    name: "graph_update_contact",
    description: `Update an Outlook contact. Only the supplied fields are changed.

Args:
    contact_id: The contact ID to update.
    given_name: New first name.
    surname: New last name.
    email: New primary email address.
    mobile_phone: New mobile phone number.
    company_name: New company name.
    job_title: New job title.`,
  },
  {
    name: "graph_delete_contact",
    description: `Delete an Outlook contact.

Args:
    contact_id: The contact ID to delete.`,
  },
  {
    name: "graph_list_contact_folders",
    description: `List contact folders.

Use the returned folder IDs with graph_list_contacts.

Args:
    top: Maximum number of folders to return (default 25, maximum 50).`,
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
    put: (path, data, body, headers) => {
      calls.push({
        method: "PUT",
        path,
        ...(data === undefined ? {} : { body: data }),
        ...(body === undefined ? {} : { params: body }),
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

function messageFrom(result: CallToolResult): unknown {
  const content = result.content[0];
  if (content?.type !== "text") {
    throw new Error("Expected a text tool result.");
  }
  const payload: unknown = JSON.parse(content.text);
  if (typeof payload !== "object" || payload === null || !("message" in payload)) {
    throw new Error("Expected a response envelope.");
  }
  return payload.message;
}

const FAKE_AUTH_MANAGER: ToolDependencies["authManager"] = {
  getStatus: () => ({ state: "unauthenticated" }),
  login: () => Promise.resolve({ state: "authenticated" }),
  logout: () => Promise.resolve(),
  getValidAccessToken: () => Promise.resolve("access-token"),
  refreshAccessToken: () => Promise.resolve(true),
};

function registerContactsHarness(graphResponses: readonly unknown[] = []): {
  readonly harness: ToolHarness;
  readonly graph: GraphFake;
} {
  const harness = createToolHarness();
  const graph = createGraphFake(graphResponses);
  registerContactsTools(harness.server, {
    authManager: FAKE_AUTH_MANAGER,
    graphClient: graph.graphClient,
  });
  return { harness, graph };
}

function alwaysRejectingGraphClient(reason: unknown): ToolDependencies["graphClient"] {
  const reject = (): Promise<never> =>
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    Promise.reject(reason);
  return { get: reject, post: reject, patch: reject, put: reject, delete: reject };
}

describe("contacts tool registration", () => {
  test("registers exactly the six contacts names and complete descriptions", () => {
    const { harness } = registerContactsHarness();

    expect(
      harness.registrations.map(({ name, config }) => ({
        name,
        description: config.description,
      })),
    ).toEqual(EXPECTED_CONTACTS_TOOLS);
  });

  test("exposes exact snake_case schemas, defaults, and required fields", () => {
    const { harness } = registerContactsHarness();

    const peopleSchema = z.object(schemaFor(harness, "graph_search_people"));
    expect(peopleSchema.parse({ query: "Ada" })).toEqual({ query: "Ada", top: 10 });
    expect(peopleSchema.safeParse({}).success).toBe(false);
    expect(peopleSchema.safeParse({ query: "Ada", top: 1.5 }).success).toBe(false);

    const listSchema = z.object(schemaFor(harness, "graph_list_contacts"));
    expect(listSchema.parse({})).toEqual({ top: 25, folder_id: "" });
    for (const folderId of [".", ".."]) {
      expect(listSchema.safeParse({ folder_id: folderId }).success).toBe(false);
    }

    expect(Object.keys(schemaFor(harness, "graph_create_contact"))).toEqual([
      "given_name",
      "surname",
      "email",
      "mobile_phone",
      "company_name",
      "job_title",
    ]);
    const createSchema = z.object(schemaFor(harness, "graph_create_contact"));
    expect(createSchema.parse({ given_name: "Ada" })).toEqual({
      given_name: "Ada",
      surname: "",
      email: "",
      mobile_phone: "",
      company_name: "",
      job_title: "",
    });
    expect(createSchema.safeParse({}).success).toBe(false);

    const updateSchema = z.object(schemaFor(harness, "graph_update_contact"));
    expect(updateSchema.parse({ contact_id: "contact-1" })).toEqual({
      contact_id: "contact-1",
      given_name: "",
      surname: "",
      email: "",
      mobile_phone: "",
      company_name: "",
      job_title: "",
    });
    for (const contactId of ["", ".", ".."]) {
      expect(updateSchema.safeParse({ contact_id: contactId }).success).toBe(false);
    }

    const deleteSchema = z.object(schemaFor(harness, "graph_delete_contact"));
    expect(deleteSchema.parse({ contact_id: "contact-1" })).toEqual({ contact_id: "contact-1" });
    expect(deleteSchema.safeParse({ contact_id: "" }).success).toBe(false);

    const foldersSchema = z.object(schemaFor(harness, "graph_list_contact_folders"));
    expect(foldersSchema.parse({})).toEqual({ top: 25 });
    expect(foldersSchema.safeParse({ top: 2.5 }).success).toBe(false);
  });
});

describe("people search", () => {
  test("escapes quotes, selects person fields, and caps top at fifty", async () => {
    const { harness, graph } = registerContactsHarness([
      { value: [{ id: "person-1" }] },
      { value: [{ id: "person-2" }] },
      {},
    ]);

    expect(dataFrom(await harness.invoke("graph_search_people", { query: "Ada" }))).toEqual([
      { id: "person-1" },
    ]);
    expect(
      dataFrom(await harness.invoke("graph_search_people", { query: 'say "hi"', top: 500 })),
    ).toEqual([{ id: "person-2" }]);
    expect(dataFrom(await harness.invoke("graph_search_people", { query: "nobody" }))).toEqual([]);

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/people",
        params: { $search: '"Ada"', $select: PERSON_FIELDS, $top: "10" },
      },
      {
        method: "GET",
        path: "/me/people",
        params: { $search: '"say ""hi"""', $select: PERSON_FIELDS, $top: "50" },
      },
      {
        method: "GET",
        path: "/me/people",
        params: { $search: '"nobody"', $select: PERSON_FIELDS, $top: "10" },
      },
    ]);
  });

  test("rejects a malformed people response", async () => {
    const { harness } = registerContactsHarness([{ value: "payload-secret" }]);

    const result = await harness.invoke("graph_search_people", { query: "Ada" });

    expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
    expect(JSON.stringify(result)).not.toContain("payload-secret");
  });
});

describe("contact listing", () => {
  test("lists the default folder, a specific folder, and caps top at fifty", async () => {
    const { harness, graph } = registerContactsHarness([
      { value: [{ id: "contact-1" }] },
      { value: [{ id: "contact-2" }] },
    ]);

    expect(dataFrom(await harness.invoke("graph_list_contacts"))).toEqual([{ id: "contact-1" }]);
    expect(
      dataFrom(
        await harness.invoke("graph_list_contacts", { top: 400, folder_id: "folder/one id" }),
      ),
    ).toEqual([{ id: "contact-2" }]);

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/contacts",
        params: { $select: CONTACT_FIELDS, $top: "25" },
      },
      {
        method: "GET",
        path: "/me/contactFolders/folder%2Fone%20id/contacts",
        params: { $select: CONTACT_FIELDS, $top: "50" },
      },
    ]);
  });

  test("lists contact folders with the capped top", async () => {
    const { harness, graph } = registerContactsHarness([{ value: [{ id: "folder-1" }] }, {}]);

    expect(dataFrom(await harness.invoke("graph_list_contact_folders", { top: 90 }))).toEqual([
      { id: "folder-1" },
    ]);
    expect(dataFrom(await harness.invoke("graph_list_contact_folders"))).toEqual([]);

    expect(graph.calls).toEqual([
      { method: "GET", path: "/me/contactFolders", params: { $top: "50" } },
      { method: "GET", path: "/me/contactFolders", params: { $top: "25" } },
    ]);
  });
});

describe("contact writes", () => {
  test("creates a contact with only the supplied fields", async () => {
    const { harness, graph } = registerContactsHarness([
      { id: "contact-1" },
      { id: "contact-2" },
      { id: "contact-3" },
    ]);

    expect(
      dataFrom(
        await harness.invoke("graph_create_contact", {
          given_name: "Ada",
          surname: "Lovelace",
          email: "ada@example.com",
          mobile_phone: "+44 100",
          company_name: "BP",
          job_title: "Engineer",
        }),
      ),
    ).toEqual({ id: "contact-1" });
    await harness.invoke("graph_create_contact", { given_name: "Ada" });
    await harness.invoke("graph_create_contact", {
      given_name: "",
      surname: "Lovelace",
      email: "ada@example.com",
    });

    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/contacts",
        body: {
          givenName: "Ada",
          surname: "Lovelace",
          emailAddresses: [{ address: "ada@example.com", name: "Ada Lovelace" }],
          mobilePhone: "+44 100",
          companyName: "BP",
          jobTitle: "Engineer",
        },
      },
      { method: "POST", path: "/me/contacts", body: { givenName: "Ada" } },
      {
        method: "POST",
        path: "/me/contacts",
        body: {
          surname: "Lovelace",
          emailAddresses: [{ address: "ada@example.com", name: "Lovelace" }],
        },
      },
    ]);
  });

  test("patches only the supplied contact fields and encodes the id", async () => {
    const { harness, graph } = registerContactsHarness([{ id: "contact-1" }, { id: "contact-1" }]);

    expect(
      dataFrom(
        await harness.invoke("graph_update_contact", {
          contact_id: "contact/1 id",
          job_title: "Lead",
        }),
      ),
    ).toEqual({ id: "contact-1" });
    await harness.invoke("graph_update_contact", {
      contact_id: "contact-1",
      given_name: "Ada",
      email: "ada@example.com",
      mobile_phone: "+44 200",
      company_name: "BP",
    });

    expect(graph.calls).toEqual([
      {
        method: "PATCH",
        path: "/me/contacts/contact%2F1%20id",
        body: { jobTitle: "Lead" },
      },
      {
        method: "PATCH",
        path: "/me/contacts/contact-1",
        body: {
          givenName: "Ada",
          emailAddresses: [{ address: "ada@example.com", name: "Ada" }],
          mobilePhone: "+44 200",
          companyName: "BP",
        },
      },
    ]);
  });

  test("returns an error envelope with no Graph call when no contact field is supplied", async () => {
    const { harness, graph } = registerContactsHarness();

    const result = await harness.invoke("graph_update_contact", { contact_id: "contact-1" });

    expect(dataFrom(result)).toEqual({ error: "At least one contact field is required." });
    expect(messageFrom(result)).toBe("error");
    expect(graph.calls).toEqual([]);
  });

  test("deletes a contact and encodes the id", async () => {
    const { harness, graph } = registerContactsHarness([{}]);

    expect(
      dataFrom(await harness.invoke("graph_delete_contact", { contact_id: "contact/1 id" })),
    ).toEqual({ status: "Contact deleted" });
    expect(graph.calls).toEqual([{ method: "DELETE", path: "/me/contacts/contact%2F1%20id" }]);
  });

  test.each([null, "text", 42, [{ id: "contact-1" }]])(
    "rejects a malformed contact write response",
    async (response) => {
      const { harness } = registerContactsHarness([response, response]);

      await expect(harness.invoke("graph_create_contact", { given_name: "Ada" })).resolves.toEqual(
        INVALID_GRAPH_RESPONSE_RESULT,
      );
      await expect(
        harness.invoke("graph_update_contact", { contact_id: "contact-1", job_title: "Lead" }),
      ).resolves.toEqual(INVALID_GRAPH_RESPONSE_RESULT);
    },
  );
});

describe("contacts authenticated wrapper errors", () => {
  test.each([
    { name: "graph_search_people", args: { query: "Ada" } },
    { name: "graph_list_contacts", args: {} },
    { name: "graph_create_contact", args: { given_name: "Ada" } },
    { name: "graph_update_contact", args: { contact_id: "contact-1", job_title: "Lead" } },
    { name: "graph_delete_contact", args: { contact_id: "contact-1" } },
    { name: "graph_list_contact_folders", args: {} },
  ])("converts an AuthenticationError from $name", async ({ name, args }) => {
    const harness = createToolHarness();
    registerContactsTools(harness.server, {
      authManager: FAKE_AUTH_MANAGER,
      graphClient: alwaysRejectingGraphClient(new AuthenticationError("Not authenticated.")),
    });

    await expect(harness.invoke(name, args)).resolves.toEqual(AUTHENTICATION_ERROR_RESULT);
  });
});
