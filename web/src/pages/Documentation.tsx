import "katex/dist/katex.min.css";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
// single source of truth: the same file is versioned in the repo (docs/) and rendered here
import source from "../../../docs/METHODOLOGIE.md?raw";

function slugify(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

interface TocEntry {
  level: 2 | 3;
  title: string;
  id: string;
}

export default function Documentation() {
  const toc = useMemo<TocEntry[]>(() => {
    const entries: TocEntry[] = [];
    let inCode = false;
    for (const line of source.split("\n")) {
      if (line.startsWith("```")) inCode = !inCode;
      const m = !inCode && /^(##|###) (.+)$/.exec(line);
      if (m) {
        const title = m[2].replace(/\$[^$]*\$/g, "").replace(/[*`]/g, "").trim();
        entries.push({ level: m[1].length as 2 | 3, title, id: slugify(title) });
      }
    }
    return entries;
  }, []);
  const [active, setActive] = useState(toc[0]?.id);

  useEffect(() => {
    const main = document.querySelector(".main");
    const onScroll = () => {
      let current = toc[0]?.id;
      for (const t of toc) {
        const el = document.getElementById(t.id);
        if (el && el.getBoundingClientRect().top < 140) current = t.id;
      }
      setActive(current);
    };
    main?.addEventListener("scroll", onScroll, { passive: true });
    return () => main?.removeEventListener("scroll", onScroll);
  }, [toc]);

  const heading = (Tag: "h2" | "h3") => ({ children }: { children?: ReactNode }) => {
    const id = slugify(textOf(children).replace(/\$[^$]*\$/g, "").replace(/[*`]/g, "").trim());
    return <Tag id={id}>{children}</Tag>;
  };

  return (
    <div className="doc-layout">
      <nav className="doc-toc" aria-label="Sommaire">
        <div className="form-group-title" style={{ marginBottom: 8 }}>Sommaire</div>
        {toc.map((t) => (
          <a key={t.id} href={`#${t.id}`} className={`${t.level === 3 ? "sub" : ""}${active === t.id ? " on" : ""}`}
            onClick={(e) => {
              e.preventDefault();
              // scroll only the content pane (scrollIntoView would also scroll the window)
              const main = document.querySelector(".main");
              const el = document.getElementById(t.id);
              if (main && el) {
                const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 12;
                main.scrollTo({ top, behavior: "smooth" });
              }
            }}>
            {t.title}
          </a>
        ))}
        <span className="doc-source">Source : docs/METHODOLOGIE.md</span>
      </nav>
      <article className="card doc">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}
          components={{ h2: heading("h2"), h3: heading("h3") }}>
          {source}
        </ReactMarkdown>
      </article>
    </div>
  );
}
