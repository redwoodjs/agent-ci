import type { ReactNode } from "react";
import compatibility from "../../../../../packages/cli/compatibility.json";

type StatusId = keyof typeof compatibility.legend;

const INLINE_MD_PATTERN = /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE_MD_PATTERN)) {
    if (m.index > lastIndex) {
      nodes.push(text.slice(lastIndex, m.index));
    }
    if (m[1] !== undefined) {
      nodes.push(
        <code key={key++} className="text-[#c2ddd0] bg-[#12211c] px-1 rounded-sm">
          {m[1]}
        </code>,
      );
    } else {
      nodes.push(
        <a
          key={key++}
          href={m[3]}
          target={m[3].startsWith("http") ? "_blank" : undefined}
          rel={m[3].startsWith("http") ? "noopener noreferrer" : undefined}
          className="text-[#9bc5b3] underline decoration-[#34594c] underline-offset-2 hover:text-[#e0eee5]"
        >
          {m[2]}
        </a>,
      );
    }
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

export function CompatibilityMatrix() {
  const legendEntries = Object.values(compatibility.legend);

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap gap-6 text-xs font-mono text-[#71a792]">
        {legendEntries.map(({ icon, label, description }) => (
          <span key={label} className="flex items-center gap-1.5">
            <span>{icon}</span>
            <span className="text-[#e0eee5]">{label}</span>
            <span className="hidden sm:inline">— {description}</span>
          </span>
        ))}
      </div>

      {compatibility.sections.map((section) => (
        <div key={section.id}>
          <h2 className="font-mono text-xs uppercase tracking-wider text-[#e0eee5] mb-0 px-4 py-2 bg-[#12211c] border border-b-0 border-[#2b483e] inline-block">
            {section.title}
          </h2>
          <p className="text-xs text-[#71a792] px-4 py-2 bg-[#0d110f] border border-b-0 border-[#2b483e] m-0">
            {renderInline(section.description)}
          </p>
          <div className="overflow-x-auto border border-[#2b483e] bg-[#0d110f]">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#34594c] bg-[#12211c]">
                  <th className="py-3 px-4 font-mono text-xs text-[#71a792] uppercase tracking-wider w-1/2">
                    Key
                  </th>
                  <th className="py-3 px-4 font-mono text-xs text-[#71a792] uppercase tracking-wider w-16">
                    Status
                  </th>
                  <th className="py-3 px-4 font-mono text-xs text-[#71a792] uppercase tracking-wider">
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {section.rows.map((row, i) => (
                  <tr
                    key={i}
                    className="border-b border-[#1a2822] hover:bg-[#12211c] transition-colors"
                  >
                    <td className="py-3 px-4 font-mono text-[#c2ddd0] text-xs">
                      {renderInline(row.key)}
                    </td>
                    <td className="py-3 px-4 text-center text-base">
                      {compatibility.legend[row.status as StatusId].icon}
                    </td>
                    <td className="py-3 px-4 text-[#71a792] text-xs">
                      {row.notes ? renderInline(row.notes) : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
