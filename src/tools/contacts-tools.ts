import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphApiError } from "../errors.js";
import { successResponse } from "../responses.js";
import { CONTACT_COMPACT_FIELDS } from "../select-fields.js";
import {
  collectionResult,
  COMPACT_ARGS_DOC,
  COMPACT_SCHEMA,
  INCLUDE_NEXT_LINK_SCHEMA,
  NEXT_LINK_SCHEMA,
  PAGING_ARGS_DOC,
  selectFields,
  SKIP_ARGS_DOC,
  SKIP_SCHEMA,
} from "./list-options.js";
import { registerAuthenticatedTool, type ToolDependencies } from "./tool-types.js";

const INVALID_GRAPH_RESPONSE_MESSAGE = "Invalid Microsoft Graph response.";
const MISSING_CONTACT_UPDATE_MESSAGE = "At least one contact field is required.";
const PERSON_FIELDS = "id,displayName,scoredEmailAddresses,jobTitle,companyName,personType";
/** The person resource has no `mail` property, so compact keeps its scored addresses. */
const PERSON_COMPACT_FIELDS = "id,displayName,scoredEmailAddresses";
const CONTACT_FIELDS =
  "id,displayName,emailAddresses,mobilePhone,businessPhones,companyName,jobTitle";
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

type GraphObject = Record<string, unknown>;

interface ContactFields {
  readonly given_name: string;
  readonly surname: string;
  readonly email: string;
  readonly mobile_phone: string;
  readonly company_name: string;
  readonly job_title: string;
}

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

interface PagedCollectionRequest {
  /** Absolute nextLink from a previous page. Empty means start from `path`. */
  readonly nextLink: string;
  readonly path: string;
  readonly params: Record<string, string>;
  readonly includeNextLink: boolean;
}

/**
 * Fetch one page of a collection. A nextLink already carries every query parameter Graph
 * needs, so it is requested bare and the caller's paging arguments are ignored.
 */
async function pagedCollection(
  graphClient: ToolDependencies["graphClient"],
  request: PagedCollectionRequest,
): Promise<string> {
  const response =
    request.nextLink === ""
      ? await graphClient.get(request.path, request.params)
      : await graphClient.get(request.nextLink);
  return successResponse(
    collectionResult(collectionValue(response), response, request.includeNextLink),
  );
}

function requireGraphObject(response: unknown): GraphObject {
  if (!isNonArrayObject(response)) {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  return response;
}

function contactName(givenName: string, surname: string): string {
  return [givenName, surname].filter((part) => part !== "").join(" ");
}

function contactPayload(fields: ContactFields): GraphObject {
  const payload: GraphObject = {};
  if (fields.given_name !== "") {
    payload.givenName = fields.given_name;
  }
  if (fields.surname !== "") {
    payload.surname = fields.surname;
  }
  if (fields.email !== "") {
    payload.emailAddresses = [
      {
        address: fields.email,
        name: contactName(fields.given_name, fields.surname),
      },
    ];
  }
  if (fields.mobile_phone !== "") {
    payload.mobilePhone = fields.mobile_phone;
  }
  if (fields.company_name !== "") {
    payload.companyName = fields.company_name;
  }
  if (fields.job_title !== "") {
    payload.jobTitle = fields.job_title;
  }
  return payload;
}

export function registerContactsTools(
  server: Pick<McpServer, "registerTool">,
  dependencies: ToolDependencies,
): void {
  registerAuthenticatedTool(
    server,
    "graph_search_people",
    {
      description: `Search people the user works with, ranked by relevance.

Covers colleagues, saved contacts, and external people the user has mailed,
so prefer this over graph_search_users when looking someone up by name.
\`$search\` on /me/people only works for the signed-in user, and Graph does not
support \`$skip\` alongside it, so page with next_link instead of an offset.
Requires the People.Read permission.

Args:
    query: Name, email address, or partial text to look up.
    top: Maximum number of people to return (default 10, maximum 50).
${COMPACT_ARGS_DOC}
${PAGING_ARGS_DOC}`,
      inputSchema: {
        query: z.string(),
        top: z.number().int().default(10),
        compact: COMPACT_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
      },
    },
    async ({ query, top, compact, next_link, include_next_link }) => {
      const escapedQuery = query.replaceAll('"', '""');

      return await pagedCollection(dependencies.graphClient, {
        nextLink: next_link,
        path: "/me/people",
        params: {
          $search: `"${escapedQuery}"`,
          $select: selectFields(PERSON_FIELDS, PERSON_COMPACT_FIELDS, compact),
          $top: String(Math.min(top, 50)),
        },
        includeNextLink: include_next_link,
      });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_contacts",
    {
      description: `List the user's saved Outlook contacts.

Args:
    top: Maximum number of contacts to return (default 25, maximum 50).
    folder_id: Contact folder ID. Empty lists the default contacts folder.
${SKIP_ARGS_DOC}
${COMPACT_ARGS_DOC}
${PAGING_ARGS_DOC}`,
      inputSchema: {
        top: TOP_SCHEMA,
        folder_id: OPTIONAL_RESOURCE_ID_SCHEMA,
        skip: SKIP_SCHEMA,
        compact: COMPACT_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
      },
    },
    async ({ top, folder_id, skip, compact, next_link, include_next_link }) => {
      const params: Record<string, string> = {
        $select: selectFields(CONTACT_FIELDS, CONTACT_COMPACT_FIELDS, compact),
        $top: String(Math.min(top, 50)),
      };
      if (skip > 0) {
        params.$skip = String(skip);
      }

      return await pagedCollection(dependencies.graphClient, {
        nextLink: next_link,
        path:
          folder_id === ""
            ? "/me/contacts"
            : `/me/contactFolders/${encodeURIComponent(folder_id)}/contacts`,
        params,
        includeNextLink: include_next_link,
      });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_create_contact",
    {
      description: `Create an Outlook contact. Requires the Contacts.ReadWrite permission.

Empty fields are omitted from the created contact.

Args:
    given_name: First name of the contact.
    surname: Last name of the contact.
    email: Primary email address.
    mobile_phone: Mobile phone number.
    company_name: Company the contact works for.
    job_title: Job title of the contact.`,
      inputSchema: {
        given_name: z.string(),
        surname: z.string().default(""),
        email: z.string().default(""),
        mobile_phone: z.string().default(""),
        company_name: z.string().default(""),
        job_title: z.string().default(""),
      },
    },
    async (fields) => {
      const result = await dependencies.graphClient.post("/me/contacts", contactPayload(fields));
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_update_contact",
    {
      description: `Update an Outlook contact. Only the supplied fields are changed.

Args:
    contact_id: The contact ID to update.
    given_name: New first name.
    surname: New last name.
    email: New primary email address.
    mobile_phone: New mobile phone number.
    company_name: New company name.
    job_title: New job title.`,
      inputSchema: {
        contact_id: RESOURCE_ID_SCHEMA,
        given_name: z.string().default(""),
        surname: z.string().default(""),
        email: z.string().default(""),
        mobile_phone: z.string().default(""),
        company_name: z.string().default(""),
        job_title: z.string().default(""),
      },
    },
    async ({ contact_id, ...fields }) => {
      const updates = contactPayload(fields);
      if (Object.keys(updates).length === 0) {
        return successResponse({ error: MISSING_CONTACT_UPDATE_MESSAGE }, "error");
      }

      const result = await dependencies.graphClient.patch(
        `/me/contacts/${encodeURIComponent(contact_id)}`,
        updates,
      );
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_delete_contact",
    {
      description: `Delete an Outlook contact.

Args:
    contact_id: The contact ID to delete.`,
      inputSchema: {
        contact_id: RESOURCE_ID_SCHEMA,
      },
    },
    async ({ contact_id }) => {
      await dependencies.graphClient.delete(`/me/contacts/${encodeURIComponent(contact_id)}`);
      return successResponse({ status: "Contact deleted" });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_contact_folders",
    {
      description: `List contact folders.

Use the returned folder IDs with graph_list_contacts.

Args:
    top: Maximum number of folders to return (default 25, maximum 50).
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
      const params: Record<string, string> = {
        $top: String(Math.min(top, 50)),
      };
      if (skip > 0) {
        params.$skip = String(skip);
      }

      return await pagedCollection(dependencies.graphClient, {
        nextLink: next_link,
        path: "/me/contactFolders",
        params,
        includeNextLink: include_next_link,
      });
    },
  );
}
