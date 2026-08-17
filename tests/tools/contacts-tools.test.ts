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
const PERSON_COMPACT_FIELDS = "id,displayName,scoredEmailAddresses";
const CONTACT_COMPACT_FIELDS = "id,displayName,emailAddresses";
const NEXT_LINK = "https://graph.microsoft.com/v1.0/me/contacts?%24skip=25&%24top=25";
const PEOPLE_NEXT_LINK = "https://graph.microsoft.com/v1.0/me/people?%24skiptoken=abc";
const FOLDERS_NEXT_LINK = "https://graph.microsoft.com/v1.0/me/contactFolders?%24skip=50";

const EXPECTED_CONTACTS_TOOLS = [
  {
    name: "graph_search_people",
    description: `Search people the user works with, ranked by relevance.

Covers colleagues, saved contacts, and external people the user has mailed,
so prefer this over graph_search_users when looking someone up by name.
\`$search\` on /me/people only works for the signed-in user, and Graph does not
support \`$skip\` alongside it, so page with next_link instead of an offset.
Requires the People.Read permission.

Args:
    query: Name, email address, or partial text to look up.
    top: Maximum number of people to return (default 10, maximum 50).
    compact: Whether to return only the identifying fields instead of the full
        record (default false). Use it to page through large collections cheaply.
    next_link: Opaque nextLink URL from a previous call, used to fetch the next
        page. Overrides the other paging arguments when supplied.
    include_next_link: Whether to wrap the result as {items, next_link} so paging
        can continue (default false, which returns a bare list).`,
  },
  {
    name: "graph_list_contacts",
    description: `List the user's saved Outlook contacts.

Args:
    top: Maximum number of contacts to return (default 25, maximum 50).
    folder_id: Contact folder ID. Empty lists the default contacts folder.
    skip: Number of items to skip before returning results (default 0). Graph
        returns at most 50 per call, so page by raising skip in steps of top.
    compact: Whether to return only the identifying fields instead of the full
        record (default false). Use it to page through large collections cheaply.
    next_link: Opaque nextLink URL from a previous call, used to fetch the next
        page. Overrides the other paging arguments when supplied.
    include_next_link: Whether to wrap the result as {items, next_link} so paging
        can continue (default false, which returns a bare list).`,
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
    top: Maximum number of folders to return (default 25, maximum 50).
    skip: Number of items to skip before returning results (default 0). Graph
        returns at most 50 per call, so page by raising skip in steps of top.
    next_link: Opaque nextLink URL from a previous call, used to fetch the next
        page. Overrides the other paging arguments when supplied.
    include_next_link: Whether to wrap the result as {items, next_link} so paging
        can continue (default false, which returns a bare list).`,
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
    getBytes: () => Promise.reject(new Error("These tools never read raw bytes.")),
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
  return {
    get: reject,
    getBytes: reject,
    post: reject,
    patch: reject,
    put: reject,
    delete: reject,
  };
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

    expect(Object.keys(schemaFor(harness, "graph_search_people"))).toEqual([
      "query",
      "top",
      "compact",
      "next_link",
      "include_next_link",
    ]);
    const peopleSchema = z.object(schemaFor(harness, "graph_search_people"));
    expect(peopleSchema.parse({ query: "Ada" })).toEqual({
      query: "Ada",
      top: 10,
      compact: false,
      next_link: "",
      include_next_link: false,
    });
    expect(peopleSchema.safeParse({}).success).toBe(false);
    expect(peopleSchema.safeParse({ query: "Ada", top: 1.5 }).success).toBe(false);
    expect(peopleSchema.safeParse({ query: "Ada", skip: 10 }).success).toBe(true);
    expect(peopleSchema.parse({ query: "Ada", skip: 10 })).not.toHaveProperty("skip");

    expect(Object.keys(schemaFor(harness, "graph_list_contacts"))).toEqual([
      "top",
      "folder_id",
      "skip",
      "compact",
      "next_link",
      "include_next_link",
    ]);
    const listSchema = z.object(schemaFor(harness, "graph_list_contacts"));
    expect(listSchema.parse({})).toEqual({
      top: 25,
      folder_id: "",
      skip: 0,
      compact: false,
      next_link: "",
      include_next_link: false,
    });
    for (const folderId of [".", ".."]) {
      expect(listSchema.safeParse({ folder_id: folderId }).success).toBe(false);
    }
    expect(listSchema.safeParse({ skip: -1 }).success).toBe(false);
    expect(listSchema.safeParse({ skip: 1.5 }).success).toBe(false);

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

    expect(Object.keys(schemaFor(harness, "graph_list_contact_folders"))).toEqual([
      "top",
      "skip",
      "next_link",
      "include_next_link",
    ]);
    const foldersSchema = z.object(schemaFor(harness, "graph_list_contact_folders"));
    expect(foldersSchema.parse({})).toEqual({
      top: 25,
      skip: 0,
      next_link: "",
      include_next_link: false,
    });
    expect(foldersSchema.safeParse({ top: 2.5 }).success).toBe(false);
  });

  test.each(["graph_search_people", "graph_list_contacts", "graph_list_contact_folders"])(
    "%s rejects a next_link that is not a Graph v1.0 URL",
    (name) => {
      const { harness } = registerContactsHarness();
      const schema = z.object(schemaFor(harness, name));

      for (const nextLink of [
        "https://evil.example.com/v1.0/me/contacts",
        "https://graph.microsoft.com/beta/me/contacts",
        "/me/contacts?$skip=25",
      ]) {
        const result = schema.safeParse({ query: "Ada", list_id: "list-1", next_link: nextLink });
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0]?.message).toBe(
            "next_link must be a Microsoft Graph v1.0 URL returned by a previous call.",
          );
        }
      }
      expect(schema.safeParse({ query: "Ada", next_link: NEXT_LINK }).success).toBe(true);
    },
  );
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

  test("selects the compact person fields and pages with a bare next_link", async () => {
    const { harness, graph } = registerContactsHarness([
      { value: [{ id: "person-1" }] },
      { value: [{ id: "person-2" }], "@odata.nextLink": PEOPLE_NEXT_LINK },
    ]);

    expect(
      dataFrom(await harness.invoke("graph_search_people", { query: "Ada", compact: true })),
    ).toEqual([{ id: "person-1" }]);
    expect(
      dataFrom(
        await harness.invoke("graph_search_people", {
          query: "ignored",
          top: 50,
          compact: true,
          next_link: PEOPLE_NEXT_LINK,
          include_next_link: true,
        }),
      ),
    ).toEqual({ items: [{ id: "person-2" }], next_link: PEOPLE_NEXT_LINK });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/people",
        params: { $search: '"Ada"', $select: PERSON_COMPACT_FIELDS, $top: "10" },
      },
      { method: "GET", path: PEOPLE_NEXT_LINK },
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

  test("selects the compact contact fields and sends skip only above zero", async () => {
    const { harness, graph } = registerContactsHarness([
      { value: [] },
      { value: [] },
      { value: [] },
    ]);

    await harness.invoke("graph_list_contacts", { compact: true });
    await harness.invoke("graph_list_contacts", { skip: 25 });
    await harness.invoke("graph_list_contacts", { skip: 0, compact: false });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/contacts",
        params: { $select: CONTACT_COMPACT_FIELDS, $top: "25" },
      },
      {
        method: "GET",
        path: "/me/contacts",
        params: { $select: CONTACT_FIELDS, $top: "25", $skip: "25" },
      },
      {
        method: "GET",
        path: "/me/contacts",
        params: { $select: CONTACT_FIELDS, $top: "25" },
      },
    ]);
  });

  test("fetches the contacts next_link bare and ignores the other arguments", async () => {
    const { harness, graph } = registerContactsHarness([
      { value: [{ id: "contact-2" }], "@odata.nextLink": NEXT_LINK },
    ]);

    expect(
      dataFrom(
        await harness.invoke("graph_list_contacts", {
          top: 50,
          folder_id: "folder-1",
          skip: 25,
          compact: true,
          next_link: NEXT_LINK,
          include_next_link: true,
        }),
      ),
    ).toEqual({ items: [{ id: "contact-2" }], next_link: NEXT_LINK });

    expect(graph.calls).toEqual([{ method: "GET", path: NEXT_LINK }]);
  });

  test("keeps a bare list by default and reports an empty next_link on the last page", async () => {
    const { harness, graph } = registerContactsHarness([
      { value: [{ id: "contact-1" }], "@odata.nextLink": NEXT_LINK },
      { value: [{ id: "folder-1" }] },
    ]);

    expect(dataFrom(await harness.invoke("graph_list_contacts"))).toEqual([{ id: "contact-1" }]);
    expect(
      dataFrom(await harness.invoke("graph_list_contact_folders", { include_next_link: true })),
    ).toEqual({ items: [{ id: "folder-1" }], next_link: "" });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/contacts",
        params: { $select: CONTACT_FIELDS, $top: "25" },
      },
      { method: "GET", path: "/me/contactFolders", params: { $top: "25" } },
    ]);
  });

  test("sends folder skip only above zero and pages folders with a bare next_link", async () => {
    const { harness, graph } = registerContactsHarness([{ value: [] }, { value: [] }]);

    await harness.invoke("graph_list_contact_folders", { top: 90, skip: 50 });
    await harness.invoke("graph_list_contact_folders", {
      top: 10,
      skip: 25,
      next_link: FOLDERS_NEXT_LINK,
    });

    expect(graph.calls).toEqual([
      { method: "GET", path: "/me/contactFolders", params: { $top: "50", $skip: "50" } },
      { method: "GET", path: FOLDERS_NEXT_LINK },
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
