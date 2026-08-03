import { z } from "zod";

import { GraphApiError } from "../errors.js";

const GRAPH_COLLECTION_PREFIX = "https://graph.microsoft.com/v1.0/";
const INVALID_NEXT_LINK_MESSAGE =
  "next_link must be a Microsoft Graph v1.0 URL returned by a previous call.";
const INVALID_GRAPH_RESPONSE_MESSAGE = "Invalid Microsoft Graph response.";
const NEXT_LINK_KEY = "@odata.nextLink";

/** Filter targets that Microsoft Graph refuses to combine with a sort order. */
const SORT_INCOMPATIBLE_FILTER_TARGETS = ["from/", "sender/", "torecipients/", "ccrecipients/"];

export const SKIP_SCHEMA = z.number().int().min(0).default(0);

export const COMPACT_SCHEMA = z.boolean().default(false);

export const INCLUDE_NEXT_LINK_SCHEMA = z.boolean().default(false);

export const NEXT_LINK_SCHEMA = z
  .string()
  .refine((value) => value === "" || value.startsWith(GRAPH_COLLECTION_PREFIX), {
    message: INVALID_NEXT_LINK_MESSAGE,
  })
  .default("");

export const BODY_TYPE_SCHEMA = z.enum(["html", "text"]).default("html");

/** Shared documentation lines so every domain describes these the same way. */
export const COMPACT_ARGS_DOC =
  "    compact: Whether to return only the identifying fields instead of the full\n" +
  "        record (default false). Use it to page through large collections cheaply.";

export const SKIP_ARGS_DOC =
  "    skip: Number of items to skip before returning results (default 0). Graph\n" +
  "        returns at most 50 per call, so page by raising skip in steps of top.";

export const PAGING_ARGS_DOC =
  "    next_link: Opaque nextLink URL from a previous call, used to fetch the next\n" +
  "        page. Overrides the other paging arguments when supplied.\n" +
  "    include_next_link: Whether to wrap the result as {items, next_link} so paging\n" +
  "        can continue (default false, which returns a bare list).";

export const BODY_TYPE_ARGS_DOC =
  '    body_type: Body format to request: "html" or "text" (default "html").\n' +
  '        Use "text" to avoid pulling large HTML bodies into context.';

/**
 * Graph rejects `$orderby` combined with a filter on recipient or sender properties with
 * "The restriction or sort order is too complex for this operation". Callers should not have
 * to know that, so drop the sort when the filter targets one of those properties.
 *
 * @param filterQuery The caller's OData filter, possibly empty.
 */
export function filterForbidsSort(filterQuery: string): boolean {
  const normalized = filterQuery.toLowerCase();
  return SORT_INCOMPATIBLE_FILTER_TARGETS.some((target) => normalized.includes(target));
}

/** Request headers that ask Graph for immutable item IDs, which survive a move. */
export function immutableIdHeaders(immutableIds: boolean): Record<string, string> | undefined {
  return immutableIds ? { Prefer: 'IdType="ImmutableId"' } : undefined;
}

/** Request headers that select the body content type Graph should return. */
export function bodyTypeHeaders(bodyType: "html" | "text"): Record<string, string> | undefined {
  return bodyType === "text" ? { Prefer: 'outlook.body-content-type="text"' } : undefined;
}

/** Merge optional header records, dropping the ones that are absent. */
export function mergeHeaders(
  ...records: readonly (Record<string, string> | undefined)[]
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  for (const record of records) {
    if (record === undefined) {
      continue;
    }
    for (const [key, value] of Object.entries(record)) {
      merged[key] = key in merged ? merged[key] + ", " + value : value;
    }
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}

/** Choose between the full and compact `$select` strings. */
export function selectFields(fullFields: string, compactFields: string, compact: boolean): string {
  return compact ? compactFields : fullFields;
}

function isNonArrayObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read `@odata.nextLink` from a collection response, returning "" when there is no next page. */
export function nextLinkFrom(response: unknown): string {
  if (!isNonArrayObject(response) || !Object.hasOwn(response, NEXT_LINK_KEY)) {
    return "";
  }
  const link = response[NEXT_LINK_KEY];
  if (typeof link !== "string") {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  return link.startsWith(GRAPH_COLLECTION_PREFIX) ? link : "";
}

/**
 * Shape a collection result. Callers that opt into paging get the nextLink alongside the
 * items; everyone else keeps the bare list the tools have always returned.
 *
 * @param items The unwrapped collection value.
 * @param response The raw Graph response, used for its nextLink.
 * @param includeNextLink Whether the caller asked for the paging wrapper.
 */
export function collectionResult(
  items: readonly unknown[],
  response: unknown,
  includeNextLink: boolean,
): unknown {
  return includeNextLink ? { items, next_link: nextLinkFrom(response) } : items;
}
