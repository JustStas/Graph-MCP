import { describe, expect, test } from "vitest";

import { GraphApiError } from "../../src/errors.js";
import {
  BODY_TYPE_SCHEMA,
  COMPACT_SCHEMA,
  INCLUDE_NEXT_LINK_SCHEMA,
  NEXT_LINK_SCHEMA,
  SKIP_SCHEMA,
  bodyTypeHeaders,
  collectionResult,
  filterForbidsSort,
  immutableIdHeaders,
  mergeHeaders,
  nextLinkFrom,
  selectFields,
} from "../../src/tools/list-options.js";

const GRAPH_PAGE = "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=abc";

describe("shared list option schemas", () => {
  test("apply the documented defaults", () => {
    expect(SKIP_SCHEMA.parse(undefined)).toBe(0);
    expect(COMPACT_SCHEMA.parse(undefined)).toBe(false);
    expect(INCLUDE_NEXT_LINK_SCHEMA.parse(undefined)).toBe(false);
    expect(NEXT_LINK_SCHEMA.parse(undefined)).toBe("");
    expect(BODY_TYPE_SCHEMA.parse(undefined)).toBe("html");
  });

  test("reject a negative or fractional skip", () => {
    expect(SKIP_SCHEMA.safeParse(-1).success).toBe(false);
    expect(SKIP_SCHEMA.safeParse(1.5).success).toBe(false);
    expect(SKIP_SCHEMA.safeParse(0).success).toBe(true);
  });

  test.each([
    { label: "empty", value: "", accepted: true },
    { label: "a Graph v1.0 page", value: GRAPH_PAGE, accepted: true },
    {
      label: "a beta page",
      value: "https://graph.microsoft.com/beta/me/messages",
      accepted: false,
    },
    { label: "another origin", value: "https://example.com/v1.0/me/messages", accepted: false },
    {
      label: "a lookalike host",
      value: "https://graph.microsoft.com.evil.test/v1.0/me/messages",
      accepted: false,
    },
    { label: "plain http", value: "http://graph.microsoft.com/v1.0/me/messages", accepted: false },
    { label: "a relative path", value: "/v1.0/me/messages", accepted: false },
  ])("next_link accepts $label: $accepted", ({ value, accepted }) => {
    expect(NEXT_LINK_SCHEMA.safeParse(value).success).toBe(accepted);
  });

  test("body_type only allows the two Graph body formats", () => {
    expect(BODY_TYPE_SCHEMA.safeParse("text").success).toBe(true);
    expect(BODY_TYPE_SCHEMA.safeParse("markdown").success).toBe(false);
  });
});

describe("filterForbidsSort", () => {
  test.each([
    "from/emailAddress/address eq 'a@bp.com'",
    "From/emailAddress/address eq 'a@bp.com'",
    "sender/emailAddress/address eq 'a@bp.com'",
    "toRecipients/any(r: r/emailAddress/address eq 'a@bp.com')",
    "ccRecipients/any(r: r/emailAddress/address eq 'a@bp.com')",
  ])("is true for %s", (filter) => {
    expect(filterForbidsSort(filter)).toBe(true);
  });

  test.each([
    "",
    "isRead eq false",
    "receivedDateTime ge 2026-08-01T00:00:00Z",
    "contains(subject,'invoice')",
  ])("is false for %s", (filter) => {
    expect(filterForbidsSort(filter)).toBe(false);
  });
});

describe("request headers", () => {
  test("immutable ids and text bodies map to Prefer headers", () => {
    expect(immutableIdHeaders(true)).toEqual({ Prefer: 'IdType="ImmutableId"' });
    expect(immutableIdHeaders(false)).toBeUndefined();
    expect(bodyTypeHeaders("text")).toEqual({
      Prefer: 'outlook.body-content-type="text"',
    });
    expect(bodyTypeHeaders("html")).toBeUndefined();
  });

  test("merging combines repeated header names into one comma-separated value", () => {
    expect(mergeHeaders(bodyTypeHeaders("text"), immutableIdHeaders(true))).toEqual({
      Prefer: 'outlook.body-content-type="text", IdType="ImmutableId"',
    });
  });

  test("merging drops absent records and returns undefined when nothing remains", () => {
    expect(mergeHeaders(undefined, immutableIdHeaders(true))).toEqual({
      Prefer: 'IdType="ImmutableId"',
    });
    expect(mergeHeaders(undefined, undefined)).toBeUndefined();
    expect(mergeHeaders()).toBeUndefined();
  });
});

describe("selectFields", () => {
  test("chooses the compact string only when compact is requested", () => {
    expect(selectFields("id,subject,body", "id", false)).toBe("id,subject,body");
    expect(selectFields("id,subject,body", "id", true)).toBe("id");
  });
});

describe("nextLinkFrom", () => {
  test("returns the Graph page link when present", () => {
    expect(nextLinkFrom({ value: [], "@odata.nextLink": GRAPH_PAGE })).toBe(GRAPH_PAGE);
  });

  test.each([
    { label: "no link", response: { value: [] } },
    { label: "a non-object", response: [] },
    { label: "an off-origin link", response: { "@odata.nextLink": "https://example.com/next" } },
    {
      label: "a beta link",
      response: { "@odata.nextLink": "https://graph.microsoft.com/beta/me/messages" },
    },
  ])("returns an empty string for $label", ({ response }) => {
    expect(nextLinkFrom(response)).toBe("");
  });

  test("rejects a non-string link", () => {
    expect(() => nextLinkFrom({ "@odata.nextLink": 7 })).toThrow(GraphApiError);
  });
});

describe("collectionResult", () => {
  test("returns the bare list by default so existing callers are unaffected", () => {
    const items = [{ id: "1" }];
    expect(collectionResult(items, { value: items, "@odata.nextLink": GRAPH_PAGE }, false)).toBe(
      items,
    );
  });

  test("wraps the list with the next link when the caller opts in", () => {
    const items = [{ id: "1" }];
    expect(collectionResult(items, { value: items, "@odata.nextLink": GRAPH_PAGE }, true)).toEqual({
      items,
      next_link: GRAPH_PAGE,
    });
  });

  test("reports an empty next link on the last page", () => {
    expect(collectionResult([], { value: [] }, true)).toEqual({ items: [], next_link: "" });
  });
});
