import { register } from "node:module";

register(new URL("./reject-node-http-adapter.mjs", import.meta.url), import.meta.url);
