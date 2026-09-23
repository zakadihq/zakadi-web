import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// typescript-eslint loads the TypeScript 6 API through the root "typescript"
// devDependency, an npm alias of @typescript/typescript6.
export default defineConfig(
  globalIgnores(["**/dist/"]),
  js.configs.recommended,
  tseslint.configs.recommended,
);
