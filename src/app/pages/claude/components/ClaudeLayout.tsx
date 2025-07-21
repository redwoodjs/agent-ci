"use client";

import { useState, useEffect, useRef } from "react";
import { FormattedMessage } from "../utils/messageFormatting";
import { ClaudeMessage } from "./ClaudeMessage";
import { MessageCircle, Loader2, ChevronDown, ImagePlus, Mic, Send, Square } from "lucide-react";
import { flattenFileTree, FlatFileItem } from "../../editor/functions";

interface ClaudeLayoutProps {
  messages: FormattedMessage[];
  loading: boolean;
  error: string;
  onExecuteQuery: (query: string) => void;
  onClearMessages: () => void;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
}

export function ClaudeLayout({
  messages,
  loading,
  error,
  onExecuteQuery,
  onClearMessages,
  autoExpandTools = false,
  showRawParameters = false,
}: ClaudeLayoutProps) {
  const [query, setQuery] = useState("");
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  
  // @ mention state
  const [showFileDropdown, setShowFileDropdown] = useState(false);
  const [fileList, setFileList] = useState<FlatFileItem[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<FlatFileItem[]>([]);
  const [selectedFileIndex, setSelectedFileIndex] = useState(-1);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [atSymbolPosition, setAtSymbolPosition] = useState(-1);

  useEffect(() => {
    // Auto-scroll to bottom when messages change
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages]);

  // Load file list on mount
  useEffect(() => {
    const loadFiles = async () => {
      try {
        const files = await flattenFileTree("/");
        setFileList(files);
      } catch (error) {
        console.warn("Could not load file list:", error);
      }
    };
    loadFiles();
  }, []);

  // @ mention detection and file filtering
  useEffect(() => {
    const textBeforeCursor = query.slice(0, cursorPosition);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');
    
    if (lastAtIndex !== -1) {
      const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);
      // Check if there's a space after the @ symbol (which would end the file reference)
      if (!textAfterAt.includes(' ')) {
        setAtSymbolPosition(lastAtIndex);
        setShowFileDropdown(true);
        
        // Filter files based on the text after @
        const filtered = fileList.filter(file => 
          file.name.toLowerCase().includes(textAfterAt.toLowerCase()) ||
          file.relativePath.toLowerCase().includes(textAfterAt.toLowerCase())
        ).slice(0, 10); // Limit to 10 results
        
        setFilteredFiles(filtered);
        setSelectedFileIndex(-1);
      } else {
        setShowFileDropdown(false);
        setAtSymbolPosition(-1);
      }
    } else {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
    }
  }, [query, cursorPosition, fileList]);

  // Scroll selected item into view
  useEffect(() => {
    if (showFileDropdown && selectedFileIndex >= 0 && dropdownRef.current) {
      const selectedElement = dropdownRef.current.children[selectedFileIndex] as HTMLElement;
      if (selectedElement) {
        selectedElement.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
        });
      }
    }
  }, [selectedFileIndex, showFileDropdown]);

  const selectFile = (file: FlatFileItem) => {
    const textBeforeAt = query.slice(0, atSymbolPosition);
    const textAfterAtQuery = query.slice(atSymbolPosition);
    const spaceIndex = textAfterAtQuery.indexOf(' ');
    const textAfterQuery = spaceIndex !== -1 ? textAfterAtQuery.slice(spaceIndex) : '';
    
    const newInput = textBeforeAt + '@' + file.relativePath + ' ' + textAfterQuery;
    const newCursorPos = textBeforeAt.length + 1 + file.relativePath.length + 1;
    
    setQuery(newInput);
    setCursorPosition(newCursorPos);
    setShowFileDropdown(false);
    setAtSymbolPosition(-1);
    
    // Focus back to textarea
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  const handleSubmit = () => {
    if (query.trim()) {
      onExecuteQuery(query);
      setQuery("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Handle file dropdown navigation
    if (showFileDropdown && filteredFiles.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedFileIndex(prev => 
          prev < filteredFiles.length - 1 ? prev + 1 : 0
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedFileIndex(prev => 
          prev > 0 ? prev - 1 : filteredFiles.length - 1
        );
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        if (selectedFileIndex >= 0) {
          e.preventDefault();
          selectFile(filteredFiles[selectedFileIndex]);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowFileDropdown(false);
        setAtSymbolPosition(-1);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setQuery(e.target.value);
    setCursorPosition(e.target.selectionStart);
  };

  return (
    <div className="h-screen flex bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white">
      {/* Sidebar */}
      <div className="w-80 flex-shrink-0 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col">
        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Claude Sessions</h2>
        </div>
        
        <div className="flex-1 p-4">
          <button className="w-full px-4 py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded font-medium text-gray-900 dark:text-white">
            New Session
          </button>
          
          <div className="mt-4 text-sm text-gray-500 dark:text-gray-400">
            <p>Session history will be available in Phase 4</p>
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="px-6 py-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Claude Code</h3>
            <button
              onClick={onClearMessages}
              className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded text-gray-700 dark:text-gray-300"
            >
              Clear
            </button>
          </div>
        </div>

        {/* Messages Area */}
        <div
          ref={messagesRef}
          className="flex-1 overflow-y-auto bg-gray-50 dark:bg-gray-900"
        >
          <div className="max-w-4xl mx-auto">
            {messages.length === 0 ? (
              <div className="flex items-center justify-center h-full min-h-[400px]">
                <div className="text-gray-500 dark:text-gray-400 text-center">
                  <MessageCircle size={48} className="mx-auto mb-4 text-gray-400 dark:text-gray-500" />
                  <div>Enter a query below to start chatting with Claude...</div>
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                {messages.map((message, index) => (
                  <ClaudeMessage
                    key={message.id}
                    message={message}
                    prevMessage={index > 0 ? messages[index - 1] : undefined}
                    autoExpandTools={autoExpandTools}
                    showRawParameters={showRawParameters}
                  />
                ))}
                {loading && (
                  <div className="px-4 py-2">
                    <div className="flex items-center space-x-3">
                      <Loader2 size={16} className="text-blue-500 animate-spin" />
                      <div className="text-gray-600 dark:text-gray-400">
                        Claude is processing your request...
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="p-2 bg-red-50 dark:bg-red-900/20 border-t border-red-200 dark:border-red-700 text-red-700 dark:text-red-200 text-sm">
            Error: {error}
          </div>
        )}

        {/* Input Area */}
        <div className="p-6 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <div className="max-w-4xl mx-auto px-4">
            {/* Input Container */}
            <div className="flex items-end gap-3 bg-gray-100 dark:bg-gray-700 rounded-2xl p-3">
              <div className="flex-1 relative">
                <textarea
                  ref={textareaRef}
                  value={query}
                  onChange={handleTextareaChange}
                  onKeyDown={handleKeyDown}
                  onSelect={(e) => setCursorPosition(e.currentTarget.selectionStart)}
                  placeholder="Ask Claude anything... (@ to reference files)"
                  className="w-full px-0 py-2 bg-transparent text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none resize-none"
                  disabled={loading}
                  rows={1}
                  style={{ minHeight: '32px', maxHeight: '120px' }}
                  onInput={(e) => {
                    // Auto-resize textarea
                    const target = e.target as HTMLTextAreaElement;
                    target.style.height = 'auto';
                    target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
                  }}
                />
                
                {/* File Dropdown */}
                {showFileDropdown && filteredFiles.length > 0 && (
                  <div 
                    ref={dropdownRef}
                    className="absolute bottom-full left-0 right-0 mb-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg max-h-48 overflow-y-auto z-50 backdrop-blur-sm">
                    {filteredFiles.map((file, index) => (
                      <div
                        key={file.path}
                        className={`px-4 py-3 cursor-pointer border-b border-gray-100 dark:border-gray-700 last:border-b-0 touch-manipulation ${
                          index === selectedFileIndex 
                            ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' 
                            : 'hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300'
                        }`}
                        onClick={() => selectFile(file)}
                      >
                        <div className="font-medium text-sm">{file.name}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                          {file.relativePath}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              
              {/* Input Actions */}
              <div className="flex items-center gap-1">
                {/* Image Button - TODO: Implement functionality */}
                <button 
                  className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                  title="Add image (coming soon)"
                >
                  <ImagePlus size={18} />
                </button>
                
                {/* Voice Button - TODO: Implement functionality */}
                <button 
                  className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                  title="Voice input (coming soon)"
                >
                  <Mic size={18} />
                </button>
                
                {/* Send/Stop Button */}
                <button
                  onClick={loading ? () => {/* TODO: Implement stop functionality */} : handleSubmit}
                  disabled={!loading && !query.trim()}
                  className={`p-2 rounded-lg transition-colors ${
                    loading 
                      ? "bg-red-500 hover:bg-red-600 text-white shadow-md" 
                      : query.trim()
                        ? "bg-blue-500 hover:bg-blue-600 text-white shadow-md"
                        : "bg-gray-300 dark:bg-gray-600 text-gray-400 cursor-not-allowed"
                  }`}
                  title={loading ? "Stop generation" : "Send message"}
                >
                  {loading ? <Square size={18} /> : <Send size={18} />}
                </button>
              </div>
            </div>
            
            {/* Model Selector - TODO: Implement functionality */}
            <div className="mt-3 flex justify-start">
              <button className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 px-3 py-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                <span>Claude 4.0 Sonnet</span>
                <ChevronDown size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}