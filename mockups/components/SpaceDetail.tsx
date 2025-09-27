import { useState } from 'react';
import { ArrowLeft, Plus, Send, Settings, Paperclip } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Badge } from './ui/badge';
import { SpaceHeader } from './SpaceHeader';
import { LeftRail } from './LeftRail';
import { MainContent } from './MainContent';

interface Space {
  id: string;
  name: string;
  description?: string;
  privacy: 'Private' | 'Shared';
  owner: string;
  coverage: number;
  freshness: 'Live' | 'Stale' | 'Fresh';
  subjects: number;
  agents: number;
  sourceCount: number;
}

interface SpaceDetailProps {
  space: Space;
  onBack: () => void;
}

export function SpaceDetail({ space, onBack }: SpaceDetailProps) {
  const [activeSection, setActiveSection] = useState<string>('ask');
  const [inputValue, setInputValue] = useState('');

  const handleSend = () => {
    if (inputValue.trim()) {
      // Handle message send
      setInputValue('');
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <SpaceHeader space={space} onBack={onBack} />
      
      <div className="flex h-[calc(100vh-80px)]">
        <LeftRail 
          activeSection={activeSection} 
          onSectionChange={setActiveSection}
          space={space}
        />
        
        <div className="flex-1 flex flex-col">
          {/* Chat Input */}
          <div className="p-6 border-b">
            <div className="max-w-4xl">
              <div className="relative">
                <Input
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  placeholder="How can I help you?"
                  className="pr-20 py-3"
                  onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                />
                <div className="absolute right-2 top-1/2 transform -translate-y-1/2 flex items-center gap-2">
                  <Button variant="ghost" size="sm">
                    <Paperclip className="w-4 h-4" />
                    Attach
                  </Button>
                  <Button variant="ghost" size="sm" className="text-xs">
                    GPT-4.1
                  </Button>
                  <Button 
                    size="sm" 
                    onClick={handleSend}
                    disabled={!inputValue.trim()}
                  >
                    <Send className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <MainContent activeSection={activeSection} space={space} />
        </div>
      </div>
    </div>
  );
}