import { MessageSquare, Clock, Tag, Bot, FileText } from "lucide-react";
import { cn } from "@/lib/utils";

import { Badge } from "@/app/components/ui/badge";
import { Stream } from "../../../types";

interface LeftRailProps {
  activeSection: string;
  onSectionChange: (section: string) => void;
  stream: Stream;
}

const sections = [
  { id: "ask", label: "Ask", icon: MessageSquare, count: null },
  { id: "entries", label: "Entries", icon: FileText, count: null },
  { id: "timeline", label: "Timeline", icon: Clock, count: null },
  { id: "subjects", label: "Subjects", icon: Tag, count: null },
  { id: "sources", label: "Sources", icon: Bot, count: null },
];

export function LeftRail({
  activeSection,
  stream,
}: {
  activeSection: string;
  stream: Stream;
}) {
  return (
    <div className="w-64 border-r bg-white border-gray-200 p-4">
      <nav className="space-y-1">
        {sections.map((section) => {
          const Icon = section.icon;
          const isActive = activeSection === section.id;
          const count = section.count;

          return (
            <a
              href={`/streams/${stream.id}/${section.id}`}
              className={cn(
                "w-full justify-start p-2 rounded-md flex items-center",
                isActive && "bg-gray-100"
              )}
            >
              <Icon className="w-4 h-4 mr-3" />
              {section.label}
              {count && (
                <Badge variant="secondary" className="ml-auto">
                  {count}
                </Badge>
              )}
            </a>
          );
        })}
      </nav>
    </div>
  );
}
