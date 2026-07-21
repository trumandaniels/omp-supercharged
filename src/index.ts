import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerHarness } from "./runtime.ts";

export default function supercharged(pi: ExtensionAPI): void {
  registerHarness(pi);
}
