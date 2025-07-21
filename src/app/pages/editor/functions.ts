"use server";

import { fetchContainer } from "@/container";

export interface FileItem {
  path: string;
  name: string;
  type: "file" | "directory";
}

async function containerFilesFetch(
  pathname: string,
  port: string,
  action: "/fs/list" | "/fs/read" | "/fs/stat" | "/fs/delete" | "/fs/write",
  fetchOptions: RequestInit = {}
) {
  const url = new URL(`http://localhost:${port}/sandbox` + action);
  url.searchParams.set("pathname", pathname);

  console.log(url);

  const response = await fetchContainer(
    new Request(url, {
      headers: {
        "Content-Type": "application/json",
      },
      ...fetchOptions,
    })
  );
  return response.json();
}

export async function getSiblingFiles({
  pathname,
  port,
}: {
  pathname: string;
  port: string;
}) {
  const files = await containerFilesFetch(pathname, port, "/fs/list");
  return files as FileItem[];
}

export async function getFile({
  pathname,
  port,
}: {
  pathname: string;
  port: string;
}) {
  const file = (await containerFilesFetch(pathname, port, "/fs/read")) as {
    content: string;
  };
  return file;
}

export async function fileType({
  pathname,
  port,
}: {
  pathname: string;
  port: string;
}) {
  const { type } = (await containerFilesFetch(pathname, port, "/fs/stat")) as {
    type: "file" | "directory";
  };
  return type;
}

export async function saveFile({
  pathname,
  content,
  port,
}: {
  pathname: string;
  content: string;
  port: string;
}) {
  return await containerFilesFetch(pathname, port, "/fs/write", {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}
