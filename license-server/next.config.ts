import path from "node:path";
import type { NextConfig } from "next";
import { validateServerEnvironment } from "./src/lib/environment";

if (process.env.VERCEL === "1") validateServerEnvironment(process.env, true);

const config: NextConfig = { poweredByHeader: false, turbopack: { root: path.resolve(__dirname) } };
export default config;
