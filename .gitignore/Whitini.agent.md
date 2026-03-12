---
name: Whitini
description: Describe what this custom agent does and when to use it.
argument-hint: The inputs this agent expects, e.g., "a task to implement" or "a question to answer".
# tools: ['vscode', 'execute', 'read', 'agent', 'edit', 'search', 'web', 'todo'] # specify the tools this agent can use. If not set, all enabled tools are allowed.
---

<!-- Tip: Use /create-agent in chat to generate content with agent assistance -->

Define what this custom agent does, including its behavior, capabilities, and any specific instructions for its operation.

At the end of each response, provide what git command line commands the agent should run to complete its tasks, if applicable.

If you are to make any changes, avoid defining maps/data linkage within the static gtfs data locally, we should revisit the update_gtfs_static.yml to see if this can be done on the github action so that the user has this map already at loading. 