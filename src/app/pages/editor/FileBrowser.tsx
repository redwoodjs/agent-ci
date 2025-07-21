import { getSiblingFiles } from "./functions";

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
  SidebarTrigger,
} from "@/app/components/ui/sidebar";

// TODO: Add back button

export async function FileBrowser({
  pathname,
  port,
}: {
  pathname: string;
  port: string;
}) {
  const files = await getSiblingFiles({ pathname, port });
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Files</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {files && files.length > 0 ? (
                  files.map((file) => (
                    <SidebarMenuItem key={file.path}>
                      <SidebarMenuButton asChild>
                        <a
                          href={`/editor/${port}${file.path}`}
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
