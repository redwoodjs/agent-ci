import { defineLinks } from "rwsdk/router";

export const link = defineLinks([
  "/",
  "/projects",
  "/projects/create",
  "/projects/:projectId",
  "/projects/:projectId/edit",

  //
  "/tasks/:containerId",
  "/tasks/:containerId/chat",
  "/tasks/:containerId/logs",
  "/tasks/:containerId/logs/:processId",
  "/tasks/:containerId/editor",
  "/tasks/:containerId/term",
  "/tasks/:containerId/preview",
]);
