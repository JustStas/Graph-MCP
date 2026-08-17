import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphApiError } from "../errors.js";
import { successResponse } from "../responses.js";
import { DRIVE_ITEM_COMPACT_FIELDS } from "../select-fields.js";
import {
  COMPACT_ARGS_DOC,
  COMPACT_SCHEMA,
  INCLUDE_NEXT_LINK_SCHEMA,
  NEXT_LINK_SCHEMA,
  PAGING_ARGS_DOC,
  SKIP_ARGS_DOC,
  SKIP_SCHEMA,
  collectionResult,
  selectFields,
} from "./list-options.js";
import { registerAuthenticatedTool, type ToolDependencies } from "./tool-types.js";

export const DRIVE_ITEM_FIELDS =
  "id,name,size,createdDateTime,lastModifiedDateTime,file,folder,webUrl,parentReference";

/**
 * Graph drops `@microsoft.graph.downloadUrl` from a response as soon as an explicit `$select`
 * is present, and naming the annotation in the `$select` does not bring it back. The annotation
 * belongs to the `content` stream property, so `content.downloadUrl` is what selects it.
 */
export const DOWNLOAD_URL_FIELD = "content.downloadUrl";

export const SHARE_LINK_FIELDS = `${DRIVE_ITEM_FIELDS},${DOWNLOAD_URL_FIELD}`;

const INVALID_GRAPH_RESPONSE_MESSAGE = "Invalid Microsoft Graph response.";
const INVALID_BASE64_MESSAGE = "Invalid base64 content.";
const FILE_METADATA_FIELDS = `id,name,size,file,${DOWNLOAD_URL_FIELD}`;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024;
const OVERSIZE_DOWNLOAD_MESSAGE = "File too large. Maximum download size is 4MB.";
const BINARY_NOTE = "Binary file — use the downloadUrl to access content.";
const MAX_STANDARD_BASE64_LENGTH = 4 * Math.ceil(MAX_UPLOAD_BYTES / 3);
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
const FOLDER_NAME_SCHEMA = z
  .string()
  .refine((value) => value !== "" && value !== "." && value !== "..", {
    message: "Folder names must not be empty, '.' or '..'.",
  });
const MISSING_MOVE_TARGET_MESSAGE = "At least one of new_parent_folder_id or new_name is required.";

const MISSING_VALUES_MESSAGE = "values must contain at least one row.";
const DRIVE_ID_ARGS_DOC = `    drive_id: Drive ID to act on. Empty targets your own OneDrive.`;

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

/** Only send `$skip` when the caller asked for it, so the default request stays unchanged. */
function skipParameter(skip: number): Record<string, string> {
  return skip > 0 ? { $skip: String(skip) } : {};
}

function driveRoot(driveId: string): string {
  return driveId === "" ? "/me/drive" : `/drives/${encodeURIComponent(driveId)}`;
}

function driveItemPath(driveId: string, itemId: string): string {
  return `${driveRoot(driveId)}/items/${encodeURIComponent(itemId)}`;
}

function worksheetPath(driveId: string, itemId: string, worksheet: string): string {
  return `${driveItemPath(driveId, itemId)}/workbook/worksheets/${encodeURIComponent(worksheet)}`;
}

function encodeSharingUrl(shareUrl: string): string {
  const base64 = Buffer.from(shareUrl, "utf8").toString("base64");
  return `u!${base64.replaceAll("/", "_").replaceAll("+", "-").replace(/=+$/, "")}`;
}

function escapedRangeAddress(address: string): string {
  return address.replaceAll("'", "''");
}

export function registerFilesTools(
  server: Pick<McpServer, "registerTool">,
  dependencies: ToolDependencies,
): void {
  registerAuthenticatedTool(
    server,
    "graph_list_files",
    {
      description: `List files and folders in OneDrive or a SharePoint document library.

Args:
    folder_id: Folder ID to list contents of. Empty for root folder.
    top: Maximum number of items to return (default 25).
${COMPACT_ARGS_DOC}
${SKIP_ARGS_DOC}
${PAGING_ARGS_DOC}
${DRIVE_ID_ARGS_DOC}`,
      inputSchema: {
        folder_id: OPTIONAL_RESOURCE_ID_SCHEMA,
        top: TOP_SCHEMA,
        compact: COMPACT_SCHEMA,
        skip: SKIP_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
        drive_id: OPTIONAL_RESOURCE_ID_SCHEMA,
      },
    },
    async ({ folder_id, top, compact, skip, next_link, include_next_link, drive_id }) => {
      const path =
        folder_id === ""
          ? `${driveRoot(drive_id)}/root/children`
          : `${driveItemPath(drive_id, folder_id)}/children`;
      const result =
        next_link === ""
          ? await dependencies.graphClient.get(path, {
              $select: selectFields(DRIVE_ITEM_FIELDS, DRIVE_ITEM_COMPACT_FIELDS, compact),
              $top: String(Math.min(top, 50)),
              ...skipParameter(skip),
            })
          : await dependencies.graphClient.get(next_link);
      return successResponse(collectionResult(collectionValue(result), result, include_next_link));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_search_files",
    {
      description: `Search for files by name or content in OneDrive or a SharePoint document library.

Graph rejects $skip on the search function, so page with next_link instead.

Args:
    query: Search query string.
    top: Maximum number of results (default 25).
${COMPACT_ARGS_DOC}
${PAGING_ARGS_DOC}
${DRIVE_ID_ARGS_DOC}`,
      inputSchema: {
        query: z.string(),
        top: TOP_SCHEMA,
        compact: COMPACT_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
        drive_id: OPTIONAL_RESOURCE_ID_SCHEMA,
      },
    },
    async ({ query, top, compact, next_link, include_next_link, drive_id }) => {
      const result =
        next_link === ""
          ? await dependencies.graphClient.get(
              `${driveRoot(drive_id)}/root/search(q='${encodeSearchQuery(query)}')`,
              {
                $select: selectFields(DRIVE_ITEM_FIELDS, DRIVE_ITEM_COMPACT_FIELDS, compact),
                $top: String(Math.min(top, 25)),
              },
            )
          : await dependencies.graphClient.get(next_link);
      return successResponse(collectionResult(collectionValue(result), result, include_next_link));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_file_content",
    {
      description: `Get the content of a file from OneDrive or a SharePoint document library.

For text-based files (txt, csv, json, etc.), returns the file content
directly. For binary files (images, docx, pdf, etc.), returns a temporary
download URL instead. Use graph_get_file_bytes when you have no way to
fetch that URL yourself.

Args:
    file_id: The file ID (from graph_list_files or graph_search_files).
${DRIVE_ID_ARGS_DOC}`,
      inputSchema: {
        file_id: RESOURCE_ID_SCHEMA,
        drive_id: OPTIONAL_RESOURCE_ID_SCHEMA,
      },
    },
    async ({ file_id, drive_id }) => {
      const path = driveItemPath(drive_id, file_id);
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
          note: BINARY_NOTE,
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
    "graph_get_file_bytes",
    {
      description: `Download a file as base64-encoded bytes (max 4MB).

Use this for a binary file when you cannot fetch the downloadUrl that
graph_get_file_content hands back. The bytes are returned in the
'contentBytes' field. Larger files are rejected, so use the downloadUrl
for those.

Args:
    file_id: The file ID (from graph_list_files or graph_search_files).
${DRIVE_ID_ARGS_DOC}`,
      inputSchema: {
        file_id: RESOURCE_ID_SCHEMA,
        drive_id: OPTIONAL_RESOURCE_ID_SCHEMA,
      },
    },
    async ({ file_id, drive_id }) => {
      const path = driveItemPath(drive_id, file_id);
      const metadata = requireGraphObject(
        await dependencies.graphClient.get(path, { $select: FILE_METADATA_FIELDS }),
      );
      const declaredSize = metadata.size;
      if (typeof declaredSize === "number" && declaredSize > MAX_DOWNLOAD_BYTES) {
        return successResponse({ error: OVERSIZE_DOWNLOAD_MESSAGE }, "error");
      }

      const bytes = await dependencies.graphClient.getBytes(`${path}/content`);
      if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
        return successResponse({ error: OVERSIZE_DOWNLOAD_MESSAGE }, "error");
      }

      return successResponse({
        name: optionalPythonValue(metadata, "name"),
        mimeType: mimeTypeFrom(metadata),
        size: bytes.byteLength,
        contentBytes: Buffer.from(bytes).toString("base64"),
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
      if (content_base64.length > MAX_STANDARD_BASE64_LENGTH) {
        return successResponse({ error: "File too large. Maximum upload size is 4MB." }, "error");
      }

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

  registerAuthenticatedTool(
    server,
    "graph_create_folder",
    {
      description: `Create a folder in OneDrive.

Args:
    folder_name: Name of the new folder.
    parent_folder_id: Parent folder ID. Empty for the drive root.`,
      inputSchema: {
        folder_name: FOLDER_NAME_SCHEMA,
        parent_folder_id: OPTIONAL_RESOURCE_ID_SCHEMA,
      },
    },
    async ({ folder_name, parent_folder_id }) => {
      const path =
        parent_folder_id === ""
          ? "/me/drive/root/children"
          : `/me/drive/items/${encodeURIComponent(parent_folder_id)}/children`;
      const result = await dependencies.graphClient.post(path, {
        name: folder_name,
        folder: {},
        "@microsoft.graph.conflictBehavior": "rename",
      });
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_delete_file",
    {
      description: `Delete a file or folder from OneDrive.

The item is moved to the OneDrive recycle bin.

Args:
    item_id: The file or folder ID to delete.`,
      inputSchema: {
        item_id: RESOURCE_ID_SCHEMA,
      },
    },
    async ({ item_id }) => {
      await dependencies.graphClient.delete(`/me/drive/items/${encodeURIComponent(item_id)}`);
      return successResponse({ status: "Item deleted" });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_move_file",
    {
      description: `Move and/or rename a file or folder in OneDrive.

At least one of new_parent_folder_id or new_name must be provided.

Args:
    item_id: The file or folder ID to move.
    new_parent_folder_id: Destination folder ID. Empty to keep the current parent.
    new_name: New name for the item. Empty to keep the current name.`,
      inputSchema: {
        item_id: RESOURCE_ID_SCHEMA,
        new_parent_folder_id: OPTIONAL_RESOURCE_ID_SCHEMA,
        new_name: z.string().default(""),
      },
    },
    async ({ item_id, new_parent_folder_id, new_name }) => {
      if (new_parent_folder_id === "" && new_name === "") {
        return successResponse({ error: MISSING_MOVE_TARGET_MESSAGE }, "error");
      }

      const updates: GraphObject = {};
      if (new_parent_folder_id !== "") {
        updates.parentReference = { id: new_parent_folder_id };
      }
      if (new_name !== "") {
        updates.name = new_name;
      }

      const result = await dependencies.graphClient.patch(
        `/me/drive/items/${encodeURIComponent(item_id)}`,
        updates,
      );
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_shared_files",
    {
      description: `List files other people have shared with the user.

Teams chat attachments do not show up here, so use graph_resolve_share_link on
the attachment contentUrl instead. Only $top is passed because sharedWithMe does
not support $select or $skip reliably, so page with next_link instead.

Args:
    top: Maximum number of items to return (default 25).
${PAGING_ARGS_DOC}`,
      inputSchema: {
        top: TOP_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
      },
    },
    async ({ top, next_link, include_next_link }) => {
      const result =
        next_link === ""
          ? await dependencies.graphClient.get("/me/drive/sharedWithMe", {
              $top: String(Math.min(top, 50)),
            })
          : await dependencies.graphClient.get(next_link);
      return successResponse(collectionResult(collectionValue(result), result, include_next_link));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_copy_file",
    {
      description: `Copy a file or folder in OneDrive.

The copy is asynchronous: Graph returns 202 with a monitor URL rather than the
finished item, so the new item may not exist yet when this call returns.

Args:
    item_id: The file or folder ID to copy.
    destination_folder_id: Destination folder ID. Empty to copy into the current parent.
    new_name: Name for the copy. Empty to keep the current name.
${DRIVE_ID_ARGS_DOC}`,
      inputSchema: {
        item_id: RESOURCE_ID_SCHEMA,
        destination_folder_id: OPTIONAL_RESOURCE_ID_SCHEMA,
        new_name: z.string().default(""),
        drive_id: OPTIONAL_RESOURCE_ID_SCHEMA,
      },
    },
    async ({ item_id, destination_folder_id, new_name, drive_id }) => {
      const body: GraphObject = {};
      if (new_name !== "") {
        body.name = new_name;
      }
      if (destination_folder_id !== "") {
        body.parentReference = { id: destination_folder_id };
      }

      await dependencies.graphClient.post(`${driveItemPath(drive_id, item_id)}/copy`, body);
      return successResponse({ status: "Copy accepted" });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_file_permissions",
    {
      description: `List who currently has access to a file or folder.

Args:
    item_id: The file or folder ID.
${PAGING_ARGS_DOC}
${DRIVE_ID_ARGS_DOC}`,
      inputSchema: {
        item_id: RESOURCE_ID_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
        drive_id: OPTIONAL_RESOURCE_ID_SCHEMA,
      },
    },
    async ({ item_id, next_link, include_next_link, drive_id }) => {
      const result =
        next_link === ""
          ? await dependencies.graphClient.get(`${driveItemPath(drive_id, item_id)}/permissions`)
          : await dependencies.graphClient.get(next_link);
      return successResponse(collectionResult(collectionValue(result), result, include_next_link));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_delete_file_permission",
    {
      description: `Revoke a sharing link or a person's access to a file or folder.

Args:
    item_id: The file or folder ID.
    permission_id: The permission ID (from graph_list_file_permissions).
${DRIVE_ID_ARGS_DOC}`,
      inputSchema: {
        item_id: RESOURCE_ID_SCHEMA,
        permission_id: RESOURCE_ID_SCHEMA,
        drive_id: OPTIONAL_RESOURCE_ID_SCHEMA,
      },
    },
    async ({ item_id, permission_id, drive_id }) => {
      await dependencies.graphClient.delete(
        `${driveItemPath(drive_id, item_id)}/permissions/${encodeURIComponent(permission_id)}`,
      );
      return successResponse({ status: "Permission deleted" });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_invite_to_file",
    {
      description: `Invite people to a file or folder by email.

Args:
    item_id: The file or folder ID to share.
    emails: Email addresses of the people to invite.
    role: Access to grant: "read" or "write" (default "read").
    send_email: Whether Graph should email the invitation (default false).
    message: Optional message to include with the invitation.
${DRIVE_ID_ARGS_DOC}`,
      inputSchema: {
        item_id: RESOURCE_ID_SCHEMA,
        emails: z.array(z.string()),
        role: z.enum(["read", "write"]).default("read"),
        send_email: z.boolean().default(false),
        message: z.string().default(""),
        drive_id: OPTIONAL_RESOURCE_ID_SCHEMA,
      },
    },
    async ({ item_id, emails, role, send_email, message, drive_id }) => {
      const body: GraphObject = {
        recipients: emails.map((email) => ({ email })),
        roles: [role],
        requireSignIn: true,
        sendInvitation: send_email,
      };
      if (message !== "") {
        body.message = message;
      }

      const result = await dependencies.graphClient.post(
        `${driveItemPath(drive_id, item_id)}/invite`,
        body,
      );
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_file_versions",
    {
      description: `List the stored versions of a file.

Args:
    item_id: The file ID.
${PAGING_ARGS_DOC}
${DRIVE_ID_ARGS_DOC}`,
      inputSchema: {
        item_id: RESOURCE_ID_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
        drive_id: OPTIONAL_RESOURCE_ID_SCHEMA,
      },
    },
    async ({ item_id, next_link, include_next_link, drive_id }) => {
      const result =
        next_link === ""
          ? await dependencies.graphClient.get(`${driveItemPath(drive_id, item_id)}/versions`)
          : await dependencies.graphClient.get(next_link);
      return successResponse(collectionResult(collectionValue(result), result, include_next_link));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_restore_file_version",
    {
      description: `Restore a file to an earlier version.

Args:
    item_id: The file ID.
    version_id: The version ID (from graph_list_file_versions).
${DRIVE_ID_ARGS_DOC}`,
      inputSchema: {
        item_id: RESOURCE_ID_SCHEMA,
        version_id: RESOURCE_ID_SCHEMA,
        drive_id: OPTIONAL_RESOURCE_ID_SCHEMA,
      },
    },
    async ({ item_id, version_id, drive_id }) => {
      await dependencies.graphClient.post(
        `${driveItemPath(drive_id, item_id)}/versions/${encodeURIComponent(
          version_id,
        )}/restoreVersion`,
      );
      return successResponse({ status: "Version restored" });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_recent_files",
    {
      description: `List what the user worked on recently across their OneDrive.

Args:
    top: Maximum number of items to return (default 25, maximum 50).
${SKIP_ARGS_DOC}
${PAGING_ARGS_DOC}`,
      inputSchema: {
        top: TOP_SCHEMA,
        skip: SKIP_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
      },
    },
    async ({ top, skip, next_link, include_next_link }) => {
      const result =
        next_link === ""
          ? await dependencies.graphClient.get("/me/drive/recent", {
              $top: String(Math.min(top, 50)),
              ...skipParameter(skip),
            })
          : await dependencies.graphClient.get(next_link);
      return successResponse(collectionResult(collectionValue(result), result, include_next_link));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_drives",
    {
      description: `List the drives the user can reach, including their OneDrive and followed document libraries.

Args:
${SKIP_ARGS_DOC}
${PAGING_ARGS_DOC}`,
      inputSchema: {
        skip: SKIP_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
      },
    },
    async ({ skip, next_link, include_next_link }) => {
      const result =
        next_link === ""
          ? await dependencies.graphClient.get("/me/drives", {
              $select: "id,name,driveType,owner,quota",
              ...skipParameter(skip),
            })
          : await dependencies.graphClient.get(next_link);
      return successResponse(collectionResult(collectionValue(result), result, include_next_link));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_resolve_share_link",
    {
      description: `Resolve a sharing link to the file or folder it points to.

The response carries a short-lived '@microsoft.graph.downloadUrl' that needs no
Authorization header, plus the 'parentReference.driveId' to pass as drive_id to
the other file tools.

Args:
    share_url: The sharing URL to resolve.`,
      inputSchema: {
        share_url: z.string(),
      },
    },
    async ({ share_url }) => {
      const result = await dependencies.graphClient.get(
        `/shares/${encodeSharingUrl(share_url)}/driveItem`,
        { $select: SHARE_LINK_FIELDS },
      );
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_search_sites",
    {
      description: `Search SharePoint sites by keyword.

Needs the Sites.Read.All permission, which requires admin consent. Listing every
site without a search term is application-only, so a query is always sent.

Args:
    query: Search query string.
    top: Maximum number of results (default 25, maximum 50).`,
      inputSchema: {
        query: z.string(),
        top: TOP_SCHEMA,
      },
    },
    async ({ query, top }) => {
      const result = await dependencies.graphClient.get("/sites", {
        search: query,
        $select: "id,name,displayName,webUrl",
        $top: String(Math.min(top, 50)),
      });
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_site_drives",
    {
      description: `List the document libraries of a SharePoint site.

Args:
    site_id: The SharePoint site ID (from graph_search_sites).
${SKIP_ARGS_DOC}
${PAGING_ARGS_DOC}`,
      inputSchema: {
        site_id: RESOURCE_ID_SCHEMA,
        skip: SKIP_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
      },
    },
    async ({ site_id, skip, next_link, include_next_link }) => {
      const result =
        next_link === ""
          ? await dependencies.graphClient.get(`/sites/${encodeURIComponent(site_id)}/drives`, {
              $select: "id,name,driveType,webUrl",
              ...skipParameter(skip),
            })
          : await dependencies.graphClient.get(next_link);
      return successResponse(collectionResult(collectionValue(result), result, include_next_link));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_worksheets",
    {
      description: `List the worksheets in an Excel workbook.

Excel workbook APIs need the Files.ReadWrite permission and only work on .xlsx files.

Args:
    item_id: The workbook file ID.
${PAGING_ARGS_DOC}
${DRIVE_ID_ARGS_DOC}`,
      inputSchema: {
        item_id: RESOURCE_ID_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
        drive_id: OPTIONAL_RESOURCE_ID_SCHEMA,
      },
    },
    async ({ item_id, next_link, include_next_link, drive_id }) => {
      const result =
        next_link === ""
          ? await dependencies.graphClient.get(
              `${driveItemPath(drive_id, item_id)}/workbook/worksheets`,
              { $select: "id,name,position,visibility" },
            )
          : await dependencies.graphClient.get(next_link);
      return successResponse(collectionResult(collectionValue(result), result, include_next_link));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_worksheet_range",
    {
      description: `Read cell values from a worksheet range.

The response \`values\` array holds the cell values, one inner array per row.
Excel workbook APIs need the Files.ReadWrite permission and only work on .xlsx files.

Args:
    item_id: The workbook file ID.
    worksheet: Worksheet ID or name.
    address: Range address (e.g. "A1:D10"). Empty reads the used range.
${DRIVE_ID_ARGS_DOC}`,
      inputSchema: {
        item_id: RESOURCE_ID_SCHEMA,
        worksheet: RESOURCE_ID_SCHEMA,
        address: z.string().default(""),
        drive_id: OPTIONAL_RESOURCE_ID_SCHEMA,
      },
    },
    async ({ item_id, worksheet, address, drive_id }) => {
      const base = worksheetPath(drive_id, item_id, worksheet);
      const path =
        address === ""
          ? `${base}/usedRange`
          : `${base}/range(address='${escapedRangeAddress(address)}')`;
      const result = await dependencies.graphClient.get(path);
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_update_worksheet_range",
    {
      description: `Write cell values to a worksheet range.

Excel workbook APIs need the Files.ReadWrite permission and only work on .xlsx files.

Args:
    item_id: The workbook file ID.
    worksheet: Worksheet ID or name.
    address: Range address to write (e.g. "A1:D10"). Its shape must match values.
    values: Cell values as a 2D array, one inner array per row. Cells may be
        strings, numbers, booleans, or null.
${DRIVE_ID_ARGS_DOC}`,
      inputSchema: {
        item_id: RESOURCE_ID_SCHEMA,
        worksheet: RESOURCE_ID_SCHEMA,
        address: z.string(),
        values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
        drive_id: OPTIONAL_RESOURCE_ID_SCHEMA,
      },
    },
    async ({ item_id, worksheet, address, values, drive_id }) => {
      if (values.length === 0) {
        return successResponse({ error: MISSING_VALUES_MESSAGE }, "error");
      }

      const result = await dependencies.graphClient.patch(
        `${worksheetPath(drive_id, item_id, worksheet)}/range(address='${escapedRangeAddress(
          address,
        )}')`,
        { values },
      );
      return successResponse(requireGraphObject(result));
    },
  );
}
