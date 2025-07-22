"use server";

import { fetchContainer } from "@/container";

export interface FileItem {
  path: string;
  name: string;
  type: "file" | "directory";
}

async function containerFilesFetch(
  pathname: string,
  containerId: string,
  action: "/fs/list" | "/fs/read" | "/fs/stat" | "/fs/delete" | "/fs/write",
  fetchOptions: RequestInit = {}
) {
  // NOTE: This will become a vite pluging, with __machinen/sandbox
  const url = new URL(`http://localhost:8911` + action);
  url.searchParams.set("pathname", pathname);

  const response = await fetchContainer({
    id: containerId,
    request: new Request(url, {
      headers: {
        "Content-Type": "application/json",
      },
      ...fetchOptions,
    }),
  });

  return response.json();
}

export async function getSiblingFiles({
  pathname,
  containerId,
}: {
  pathname: string;
  containerId: string;
}) {
  const files = await containerFilesFetch(pathname, containerId, "/fs/list");
  return files as FileItem[];
}

export async function getFile({
  pathname,
  containerId,
}: {
  pathname: string;
  containerId: string;
}) {
  const file = (await containerFilesFetch(
    pathname,
    containerId,
    "/fs/read"
  )) as {
    content: string;
  };
  return file;
}

export async function fileType({
  pathname,
  containerId,
}: {
  pathname: string;
  containerId: string;
}) {
  const { type } = (await containerFilesFetch(
    pathname,
    containerId,
    "/fs/stat"
  )) as {
    type: "file" | "directory";
  };
  return type;
}

export async function saveFile({
  pathname,
  content,
  containerId,
}: {
  pathname: string;
  content: string;
  containerId: string;
}) {
  return await containerFilesFetch(pathname, containerId, "/fs/write", {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}
