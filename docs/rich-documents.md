# Rich documents

Alpha includes a Rich documents skill for substantial specs, reviews, and quantitative reports. Ask for an HTML document or invoke `/rich-documents`. For short answers or ordinary code changes, continue using chat. Ask for plain text or Markdown whenever that is the output you want.

The response includes a takeaway and an **Open document** link. Open it to read the document and use the available evidence links, table sorting/filtering, or chart/table view. The underlying HTML remains a normal workspace file: edit it with your usual source tools, and refresh or reopen the same preview. Keep the file at the same path to preserve earlier links. Previously saved links require their workspace folder to be open. The preview explains unsupported content or unavailable files so you can correct the source or reopen the folder.

In **Settings → Skills → Built-in**, inspect the bundled instructions or toggle **Enabled**, then **Save**. Unsaved edits remain local to Settings. Disabling removes the built-in from future eligible skill discovery without deleting documents, user skills, or instructions already captured by an in-flight task.

To use your own guidance, create a skill named `rich-documents` in the workspace's `.alpha/skills/rich-documents/SKILL.md`, or in your personal `~/.alpha/skills/rich-documents/SKILL.md`. Workspace overrides win over personal overrides, which win over the built-in. Existing `.agents` directories and mode restrictions continue to work; Alpha-specific guidance wins at the same source and mode. An override applies only in its eligible modes. If you remove an override, the next eligible source is used; a disabled built-in remains disabled. Relative references resolve from your selected skill's directory. Extension updates do not overwrite your skill or template files.

Bundled examples and references ship inside Alpha. They require no project setup, plugin installation, network connection, or package download. Source evidence and external links still refer to their actual files or websites; unavailable evidence is not fabricated.
