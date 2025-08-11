"use server";

import { env } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";

import { fetchContainer } from "@/container";

export type FileItem = Awaited<ReturnType<typeof getFiles>>[number];

export async function getFiles(
  containerId: string,
  pathname: string,
  basePath: string = "/workspace"
) {
  const sandbox = getSandbox(env.Sandbox, containerId);
  const result = await sandbox.exec("ls -la " + basePath + pathname);

  // Parse the ls -la output to extract file information
  const lines = result.stdout
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("total"));
  const files = [];

  for (const line of lines) {
    // Skip current and parent directory entries
    if (line.endsWith(".") || line.endsWith(" ..")) {
      continue;
    }

    // Parse ls -la format: permissions user group size date time name
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;

    const permissions = parts[0];
    const name = parts.slice(8).join(" "); // Handle filenames with spaces

    // Determine type based on first character of permissions
    let type: "file" | "directory" | "symlink" | "other";
    switch (permissions[0]) {
      case "d":
        type = "directory";
        break;
      case "l":
        type = "symlink";
        break;
      case "-":
        type = "file";
        break;
      default:
        type = "other";
    }

    files.push({
      name,
      path: pathname + "/" + name,
      type,
      permissions: permissions.slice(1),
      size: parts[4],
      modified: `${parts[5]} ${parts[6]} ${parts[7]}`,
    });
  }

  return files;
}

export async function getFileContent(
  containerId: string,
  pathname: string,
  basePath: string = "/workspace"
) {
  const sandbox = getSandbox(env.Sandbox, containerId);
  const result = await sandbox.readFile(basePath + pathname);
  return result.content;
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
    containerId,
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

export async function getFileType(
  containerId: string,
  pathname: string,
  basePath: string = "/workspace"
) {
  const sandbox = getSandbox(env.Sandbox, containerId);
  const result = await sandbox.exec("stat -c %F " + basePath + pathname);
  // determine if file or directory

  if (result.stdout.includes("directory")) {
    return "directory";
  } else {
    return "file";
  }
}

export async function saveFile(
  containerId: string,
  pathname: string,
  content: string,
  basePath: string = "/workspace"
) {
  const sandbox = getSandbox(env.Sandbox, containerId);
  await sandbox.writeFile(basePath + pathname, content);
}

export interface FlatFileItem {
  name: string;
  path: string;
  relativePath: string;
}

async function getAllFiles(
  basePath: string,
  containerId: string,
  currentPath: string = ""
): Promise<FlatFileItem[]> {
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
        if (depth < 5) {
          // Limit to 5 levels deep
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

export async function flattenFileTree(
  basePath: string = "/",
  containerId: string
): Promise<FlatFileItem[]> {
  const files = await getAllFiles(basePath, containerId);

  // Filter out common directories to ignore
  const filtered = files.filter((file) => {
    const path = file.relativePath.toLowerCase();
    return (
      !path.includes("node_modules/") &&
      !path.includes(".git/") &&
      !path.includes("dist/") &&
      !path.includes("build/") &&
      !path.includes(".next/") &&
      !path.includes("coverage/") &&
      !path.endsWith(".DS_Store")
    );
  });

  // Sort by name for better user experience
  return filtered.sort((a, b) => a.name.localeCompare(b.name));
}
