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

export interface FlatFileItem {
  name: string;
  path: string;
  relativePath: string;
}

async function getAllFiles(basePath: string, containerId: string, currentPath: string = ""): Promise<FlatFileItem[]> {
  const files: FlatFileItem[] = [];
  const fullPath = basePath + currentPath;
  
  try {
    const items = await getSiblingFiles({ pathname: fullPath, containerId });
    
    for (const item of items) {
      const itemPath = currentPath + "/" + item.name;
      const fullItemPath = fullPath + "/" + item.name;
      
      if (item.type === "file") {
        files.push({
          name: item.name,
          path: fullItemPath,
          relativePath: itemPath.startsWith("/") ? itemPath.slice(1) : itemPath,
        });
      } else if (item.type === "directory") {
        // Recursively get files from subdirectories (limit depth for performance)
        const depth = itemPath.split("/").length;
        if (depth < 5) { // Limit to 5 levels deep
          const subFiles = await getAllFiles(basePath, containerId, itemPath);
          files.push(...subFiles);
        }
      }
    }
  } catch (error) {
    // Skip directories that can't be read
    console.warn(`Could not read directory: ${fullPath}`, error);
  }
  
  return files;
}

export async function flattenFileTree(basePath: string = "/", containerId: string): Promise<FlatFileItem[]> {
  const files = await getAllFiles(basePath, containerId);
  
  // Filter out common directories to ignore
  const filtered = files.filter(file => {
    const path = file.relativePath.toLowerCase();
    return !path.includes("node_modules/") &&
           !path.includes(".git/") &&
           !path.includes("dist/") &&
           !path.includes("build/") &&
           !path.includes(".next/") &&
           !path.includes("coverage/") &&
           !path.endsWith(".DS_Store");
  });
  
  // Sort by name for better user experience
  return filtered.sort((a, b) => a.name.localeCompare(b.name));
}
