import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphApiError } from "../errors.js";
import { successResponse } from "../responses.js";
import { registerAuthenticatedTool, type ToolDependencies } from "./tool-types.js";

export const DRIVE_ITEM_FIELDS =
  "id,name,size,createdDateTime,lastModifiedDateTime,file,folder,webUrl,parentReference";

const INVALID_GRAPH_RESPONSE_MESSAGE = "Invalid Microsoft Graph response.";
const INVALID_BASE64_MESSAGE = "Invalid base64 content.";
const FILE_METADATA_FIELDS = "id,name,size,file,@microsoft.graph.downloadUrl";
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const TEXT_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/csv",
] as const;
const RESOURCE_ID_SCHEMA = z
  .string()
  .refine((value) => value !== "" && value !== "." && value !== "..", {
    message: "Resource IDs must not be empty, '.' or '..'.",
  });
const OPTIONAL_RESOURCE_ID_SCHEMA = z
  .string()
  .refine((value) => value === "" || (value !== "." && value !== ".."), {
    message: "Resource IDs must not be '.' or '..'.",
  })
  .default("");
const TOP_SCHEMA = z.number().int().default(25);
const FILE_PATH_SCHEMA = z.string().refine(isSafeDestinationPath, {
  message: "File path must be relative and contain no empty, '.' or '..' segments.",
});

type GraphObject = Record<string, unknown>;

function isNonArrayObject(value: unknown): value is GraphObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectionValue(response: unknown): unknown[] {
  if (!isNonArrayObject(response)) {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  if (!Object.hasOwn(response, "value")) {
    return [];
  }
  if (!Array.isArray(response.value)) {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  return response.value;
}

function requireGraphObject(response: unknown): GraphObject {
  if (!isNonArrayObject(response)) {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  return response;
}

function requireGraphString(response: unknown): string {
  if (typeof response !== "string") {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  return response;
}

function mimeTypeFrom(metadata: GraphObject): string {
  if (!Object.hasOwn(metadata, "file")) {
    return "";
  }
  if (!isNonArrayObject(metadata.file)) {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  if (!Object.hasOwn(metadata.file, "mimeType")) {
    return "";
  }
  if (typeof metadata.file.mimeType !== "string") {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  return metadata.file.mimeType;
}

function optionalPythonValue(metadata: GraphObject, key: string): unknown {
  return Object.hasOwn(metadata, key) ? metadata[key] : null;
}

function downloadUrlFrom(metadata: GraphObject): unknown {
  const key = "@microsoft.graph.downloadUrl";
  return Object.hasOwn(metadata, key) ? metadata[key] : "";
}

function encodeSearchQuery(query: string): string {
  const escapedODataValue = query.replaceAll("'", "''");
  return [...escapedODataValue]
    .map((character) =>
      /^[A-Za-z0-9\-._~!$&'()*+,;=:@ ]$/.test(character)
        ? character
        : encodeURIComponent(character),
    )
    .join("");
}

function isSafeDestinationPath(filePath: string): boolean {
  if (filePath === "" || filePath.startsWith("/")) {
    return false;
  }
  return filePath
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function destinationPath(filePath: string): string {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

function invalidBase64(): never {
  throw new Error(INVALID_BASE64_MESSAGE);
}

function decodeStrictBase64(contentBase64: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) {
    return invalidBase64();
  }

  const normalized = contentBase64.replace(/=+$/, "");
  const remainder = normalized.length % 4;
  if (remainder === 1 || (contentBase64.includes("=") && contentBase64.length % 4 !== 0)) {
    return invalidBase64();
  }

  const padded = normalized + "=".repeat((4 - remainder) % 4);
  const decoded = Buffer.from(padded, "base64");
  const canonical = decoded.toString("base64").replace(/=+$/, "");
  if (canonical !== normalized) {
    return invalidBase64();
  }

  return new Uint8Array(decoded);
}

export function registerFilesTools(
  server: Pick<McpServer, "registerTool">,
  dependencies: ToolDependencies,
): void {
  registerAuthenticatedTool(
    server,
    "graph_list_files",
    {
      description: `List files and folders in OneDrive.

Args:
    folder_id: Folder ID to list contents of. Empty for root folder.
    top: Maximum number of items to return (default 25).`,
      inputSchema: {
        folder_id: OPTIONAL_RESOURCE_ID_SCHEMA,
        top: TOP_SCHEMA,
      },
    },
    async ({ folder_id, top }) => {
      const path =
        folder_id === ""
          ? "/me/drive/root/children"
          : `/me/drive/items/${encodeURIComponent(folder_id)}/children`;
      const result = await dependencies.graphClient.get(path, {
        $select: DRIVE_ITEM_FIELDS,
        $top: String(Math.min(top, 50)),
      });
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_search_files",
    {
      description: `Search for files in OneDrive by name or content.

Args:
    query: Search query string.
    top: Maximum number of results (default 25).`,
      inputSchema: {
        query: z.string(),
        top: TOP_SCHEMA,
      },
    },
    async ({ query, top }) => {
      const result = await dependencies.graphClient.get(
        `/me/drive/root/search(q='${encodeSearchQuery(query)}')`,
        {
          $select: DRIVE_ITEM_FIELDS,
          $top: String(Math.min(top, 25)),
        },
      );
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_file_content",
    {
      description: `Get the content of a file from OneDrive.

For text-based files (txt, csv, json, etc.), returns the file content
directly. For binary files (images, docx, pdf, etc.), returns a
temporary download URL instead.

Args:
    file_id: The file ID (from graph_list_files or graph_search_files).`,
      inputSchema: {
        file_id: RESOURCE_ID_SCHEMA,
      },
    },
    async ({ file_id }) => {
      const path = `/me/drive/items/${encodeURIComponent(file_id)}`;
      const metadata = requireGraphObject(
        await dependencies.graphClient.get(path, { $select: FILE_METADATA_FIELDS }),
      );
      const mimeType = mimeTypeFrom(metadata);
      const isText = TEXT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));

      if (!isText) {
        return successResponse({
          name: optionalPythonValue(metadata, "name"),
          mimeType,
          size: optionalPythonValue(metadata, "size"),
          downloadUrl: downloadUrlFrom(metadata),
          note: "Binary file — use the downloadUrl to access content.",
        });
      }

      const content = requireGraphString(await dependencies.graphClient.get(`${path}/content`));
      return successResponse({
        name: optionalPythonValue(metadata, "name"),
        mimeType,
        content,
      });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_upload_file",
    {
      description: `Upload a small file to OneDrive (max 4MB).

Args:
    file_path: Destination path in OneDrive (e.g. "Documents/report.txt").
    content_base64: File content encoded as base64 string.`,
      inputSchema: {
        file_path: FILE_PATH_SCHEMA,
        content_base64: z.string(),
      },
    },
    async ({ file_path, content_base64 }) => {
      const fileBytes = decodeStrictBase64(content_base64);
      if (fileBytes.byteLength > MAX_UPLOAD_BYTES) {
        return successResponse({ error: "File too large. Maximum upload size is 4MB." }, "error");
      }

      const result = await dependencies.graphClient.put(
        `/me/drive/root:/${destinationPath(file_path)}:/content`,
        fileBytes,
        undefined,
        { "Content-Type": "application/octet-stream" },
      );
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_share_file",
    {
      description: `Create a sharing link for a OneDrive file.

Args:
    file_id: The file ID to share.
    share_type: Permission type: "view", "edit", or "embed" (default "view").
    scope: Share scope: "anonymous", "organization", or "users" (default "organization").`,
      inputSchema: {
        file_id: RESOURCE_ID_SCHEMA,
        share_type: z.string().default("view"),
        scope: z.string().default("organization"),
      },
    },
    async ({ file_id, share_type, scope }) => {
      const result = await dependencies.graphClient.post(
        `/me/drive/items/${encodeURIComponent(file_id)}/createLink`,
        { type: share_type, scope },
      );
      return successResponse(requireGraphObject(result));
    },
  );
}
