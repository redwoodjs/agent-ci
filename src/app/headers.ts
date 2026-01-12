import { RouteMiddleware } from "rwsdk/router";
import { IS_DEV } from "rwsdk/constants";

export const setCommonHeaders =
  (): RouteMiddleware =>
  ({ response, rw: { nonce } }) => {
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set("Vary", "Origin");
    response.headers.set("Access-Control-Allow-Credentials", "true");

    // Explicitly allow framing from any origin (required for VS Code webviews)
    response.headers.set("Content-Security-Policy", "frame-ancestors *");
    response.headers.delete("X-Frame-Options");
  };
