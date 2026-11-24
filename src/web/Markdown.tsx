import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Model text is untrusted: react-markdown builds React elements and never renders raw HTML.
const components: Components = {
  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
  table: ({ children }) => <div className="scroll md-table"><table className="grid">{children}</table></div>,
  code: ({ className, children }) => (className ? <code className={className}>{children}</code> : <code className="md-code">{children}</code>),
}

export function Markdown({ text }: { text: string }) {
  return <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown></div>
}
