import { FileItem } from "./functions";

import { Folder, File } from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/app/components/ui/sidebar";

export async function FileBrowser({
  files,
  pathname,
  containerId,
}: {
  files: FileItem[];
  pathname: string;
  containerId: string;
}) {
  const isRoot = pathname.split("/").length === 1;

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Files</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {!isRoot && (
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild>
                      <a
                        href={`/editor/${containerId}${pathname
                          .split("/")
                          .slice(0, -2)
                          .join("/")}`}
                      >
                        <Folder className="text-blue-500" />
                        ..
                      </a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}

                {files && files.length > 0 ? (
                  files.map((file) => (
                    <SidebarMenuItem key={file.name}>
                      <SidebarMenuButton asChild>
                        <a
                          href={`/editor/${containerId}${file.path}`}
                          className="font-weight-bold"
                        >
                          {file.type === "directory" ? (
                            <Folder className="text-blue-500" />
                          ) : (
                            <File />
                          )}
                          {file.name}
                        </a>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))
                ) : (
                  <p>No files found.</p>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
    </SidebarProvider>
  );
}
