import { MessageSquare, Clock, Tag, Bot, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { requestInfo } from "rwsdk/worker";

const sections = [
  { id: "ask", label: "Ask", icon: MessageSquare, count: null },
  { id: "artifacts", label: "Artifacts", icon: FileText, count: null },
  { id: "subjects", label: "Subjects", icon: Tag, count: null },
  { id: "sources", label: "Sources", icon: Bot, count: null },
];

export function LeftRail() {
  const { params } = requestInfo;

  return (
    <div className="w-64 border-r bg-white border-gray-200 p-4">
      <nav className="space-y-1">
        {sections.map((section) => {
          const Icon = section.icon;
          const isActive = false;
          // const isActive = activeSection === section.id;
          // const count = section.count;

          return (
            <a
              href={`/streams/${params.streamID}/${section.id}`}
              key={section.id}
              className={cn(
                "w-full justify-start p-2 rounded-md flex items-center",
                isActive && "bg-gray-100"
              )}
            >
              <Icon className="w-4 h-4 mr-3" />
              {section.label}
            </a>
          );
        })}
      </nav>
    </div>
  );
}
