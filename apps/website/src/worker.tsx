import { render, route } from "rwsdk/router";
import { defineApp } from "rwsdk/worker";

import { Document } from "@/app/document";
import { setCommonHeaders } from "@/app/headers";

import { Home } from "@/app/pages/home";
import { Compatibility } from "@/app/pages/compatibility";

export type AppContext = {};

export default defineApp([
  setCommonHeaders(),
  () => {
    // setup ctx here
  },
  render(Document, [route("/", Home), route("/compatibility", Compatibility)]),
]);
