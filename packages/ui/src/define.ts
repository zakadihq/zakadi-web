// @zakadi/ui/define: registers `<zakadi-call>` on import, the package's one side effect
// (spec/06-web-sdk.md 6.1.2); in Node it registers nothing (6.5).
import { defineZakadiCall } from "./index";

defineZakadiCall();
