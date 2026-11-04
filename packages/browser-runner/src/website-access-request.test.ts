import { expect, it } from "vitest";
import { websiteAccessFromRequest } from "./website-access-request.js";
it("accepts only reserved owner transport metadata, never a model action policy", () => {
 const policy = { mode: "allow_all", domains: [] };
 expect(websiteAccessFromRequest({ headers: {} }, { _pagsBrowserWebsiteAccess: policy })).toBeUndefined();
 expect(websiteAccessFromRequest({ headers: { "x-pags-website-policy": "1" } }, { browserWebsiteAccess: policy })).toBeUndefined();
 expect(websiteAccessFromRequest({ headers: { "x-pags-website-policy": "1" } }, { _pagsBrowserWebsiteAccess: policy })).toEqual(policy);
 expect(() => websiteAccessFromRequest({ headers: { "x-pags-website-policy": "1" } }, { _pagsBrowserWebsiteAccess: {} })).toThrow();
});
