## Command execution strategy

- Run one direct command at a time with its working directory set to the task workspace.
- Use file tools to list, read, and edit files whenever they are available.
- Do not chain commands, pipe or redirect output, use command substitution, or run inline shell code.
- Do not include shell operator or metacharacter characters in command text, including inside quoted arguments. The current evaluation gate rejects these characters even when quoted.
- Review each command result before deciding on the next direct command.
- Continue to follow the existing approval and workspace policies. This instruction does not grant additional permissions.
