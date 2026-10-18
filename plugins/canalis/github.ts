import { GitHubProvider } from "../../src/providers/github.js";
import { plugin } from "./adapter.js";

const github = plugin(new GitHubProvider(), "GITHUB_WEBHOOK_SECRET");
export const describe = github.describe;
export const verify = github.verify;
