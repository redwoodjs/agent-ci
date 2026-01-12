import type { components } from "@/app/ingestors/discord/discord-api-types";
import ReactMarkdown from "react-markdown";

type DiscordMessage = components["schemas"]["MessageResponse"];
type DiscordUser = components["schemas"]["UserResponse"];
type DiscordAttachment = components["schemas"]["MessageAttachmentResponse"];

interface DiscordConversationProps {
  messages: DiscordMessage[];
}

function getAvatarUrl(user: DiscordUser): string {
  if (user.avatar) {
    // Check if avatar is animated (starts with "a_")
    const extension = user.avatar.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${extension}`;
  }
  // Default Discord avatar - use discriminator if available, otherwise use user ID modulo 5
  let defaultAvatar = 0;
  if (user.discriminator && user.discriminator !== "0") {
    const discriminatorNum = Number.parseInt(user.discriminator, 10);
    if (!isNaN(discriminatorNum)) {
      defaultAvatar = discriminatorNum % 5;
    }
  } else {
    // For users without discriminator, use a hash of the user ID
    defaultAvatar = Number.parseInt(user.id.slice(-1), 16) % 5;
  }
  return `https://cdn.discordapp.com/embed/avatars/${defaultAvatar}.png`;
}

function getUserDisplayName(user: DiscordUser): string {
  return user.global_name || user.username || "Unknown User";
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function isImageAttachment(attachment: DiscordAttachment): boolean {
  const contentType = attachment.content_type?.toLowerCase() || "";
  const filename = attachment.filename?.toLowerCase() || "";
  return (
    contentType.startsWith("image/") ||
    /\.(jpg|jpeg|png|gif|webp)$/i.test(filename)
  );
}

function MessageComponent({ message }: { message: DiscordMessage }) {
  const avatarUrl = getAvatarUrl(message.author);
  const displayName = getUserDisplayName(message.author);
  const timestamp = formatTimestamp(message.timestamp);
  const isEdited = message.edited_timestamp !== null && message.edited_timestamp !== undefined;

  return (
    <div className="flex gap-3 py-3 px-4 hover:bg-gray-50 transition-colors">
      <div className="flex-shrink-0">
        <img
          src={avatarUrl}
          alt={displayName}
          className="w-10 h-10 rounded-full"
          onError={(e) => {
            // Fallback to a default avatar if image fails to load
            const target = e.target as HTMLImageElement;
            target.src = "https://cdn.discordapp.com/embed/avatars/0.png";
          }}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-1">
          <span className="font-semibold text-gray-900">{displayName}</span>
          {message.author.bot && (
            <span className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">
              BOT
            </span>
          )}
          <span className="text-xs text-gray-500">{timestamp}</span>
          {isEdited && (
            <span className="text-xs text-gray-400 italic">(edited)</span>
          )}
        </div>
        {message.content && (
          <div className="text-gray-800 prose prose-sm max-w-none">
            <ReactMarkdown
              components={{
                a: ({ node, ...props }) => (
                  <a
                    {...props}
                    className="text-blue-600 hover:text-blue-800 underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                ),
                p: ({ node, ...props }) => (
                  <p {...props} className="mb-2 last:mb-0" />
                ),
                code: ({ node, ...props }) => (
                  <code
                    {...props}
                    className="bg-gray-100 px-1 py-0.5 rounded text-sm font-mono"
                  />
                ),
                pre: ({ node, ...props }) => (
                  <pre
                    {...props}
                    className="bg-gray-100 p-2 rounded text-sm font-mono overflow-x-auto mb-2"
                  />
                ),
              }}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <div className="mt-2 space-y-2">
            {message.attachments.map((attachment, idx) => (
              <div key={idx} className="max-w-2xl">
                {isImageAttachment(attachment) && attachment.url ? (
                  <img
                    src={attachment.url}
                    alt={attachment.filename || "Attachment"}
                    className="max-w-full h-auto rounded-md border border-gray-200"
                    onError={(e) => {
                      // Hide image if it fails to load
                      const target = e.target as HTMLImageElement;
                      target.style.display = "none";
                    }}
                  />
                ) : (
                  <a
                    href={attachment.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-md text-sm text-gray-700"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.414a2 2 0 00-2.828-2.828L9.586 10.172 7.757 8.343a2 2 0 10-2.828 2.828l1.829 1.829a2 2 0 002.828 0L15.172 7z"
                      />
                    </svg>
                    {attachment.filename || "Attachment"}
                    {attachment.size && (
                      <span className="text-gray-500 text-xs">
                        ({formatBytes(attachment.size)})
                      </span>
                    )}
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
        {message.embeds && message.embeds.length > 0 && (
          <div className="mt-2 space-y-2">
            {message.embeds.map((embed, idx) => (
              <div
                key={idx}
                className="border-l-4 border-blue-500 bg-gray-50 p-3 rounded-r-md max-w-2xl"
              >
                {embed.title && (
                  <div className="font-semibold text-gray-900 mb-1">
                    {embed.title}
                  </div>
                )}
                {embed.description && (
                  <div className="text-sm text-gray-700 mb-2">
                    {embed.description}
                  </div>
                )}
                {embed.url && (
                  <a
                    href={embed.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-600 hover:text-blue-800"
                  >
                    {embed.url}
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(1)} ${sizes[i]}`;
}

export function DiscordConversation({ messages }: DiscordConversationProps) {
  // Sort messages by timestamp to ensure correct order
  const sortedMessages = [...messages].sort(
    (a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  if (sortedMessages.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        No messages found in this conversation.
      </div>
    );
  }

  return (
    <div className="border rounded-md bg-white divide-y divide-gray-100 max-h-[70vh] overflow-y-auto">
      {sortedMessages.map((message) => (
        <MessageComponent key={message.id} message={message} />
      ))}
    </div>
  );
}
