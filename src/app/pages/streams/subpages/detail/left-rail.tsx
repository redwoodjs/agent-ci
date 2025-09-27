"use client";

import { MessageSquare, Clock, Tag, Bot } from 'lucide-react';
import { Button } from '@/app/components/ui/button';
import { Badge } from '@/app/components/ui/badge';
import { Stream } from '../../types';

interface LeftRailProps {
  activeSection: string;
  onSectionChange: (section: string) => void;
  stream: Stream;
}

const sections = [
  { id: 'ask', label: 'Ask', icon: MessageSquare, count: null },
  { id: 'timeline', label: 'Timeline', icon: Clock, count: null },
  { id: 'subjects', label: 'Subjects', icon: Tag, count: null },
  { id: 'sources', label: 'Sources', icon: Bot, count: 5 },
];

export function LeftRail({ activeSection, onSectionChange, stream }: LeftRailProps) {
  const handleSectionClick = (sectionID: string) => {
    window.location.href = `/streams/${stream.id}/${sectionID}`;
  };

  return (
    <div className="w-64 border-r bg-background p-4">
      <nav className="space-y-1">
        {sections.map((section) => {
          const Icon = section.icon;
          const isActive = activeSection === section.id;
          const count = section.id === 'sources' ? stream.sourceCount : section.count;
          
          return (
            <Button
              key={section.id}
              variant={isActive ? 'secondary' : 'ghost'}
              className="w-full justify-start"
              onClick={() => handleSectionClick(section.id)}
            >
              <Icon className="w-4 h-4 mr-3" />
              {section.label}
              {count && (
                <Badge variant="secondary" className="ml-auto">
                  {count}
                </Badge>
              )}
            </Button>
          );
        })}
      </nav>
    </div>
  );
}