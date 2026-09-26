// The two Node.js calls the unsupported.js test makes. The workspace has no
// @types/node (the root package.json is not this ticket's), and function declarations
// merge with any other declaration of these modules.
declare module "node:fs" {
  export function readFileSync(path: URL, encoding: "utf8"): string;
}

declare module "node:vm" {
  export function runInNewContext(code: string, context: object): unknown;
}
