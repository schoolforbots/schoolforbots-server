# Security Policy

English | [简体中文](SECURITY.zh-CN.md)

## Supported versions

Only the latest version on the `main` branch is maintained, and security fixes are made on `main` only.

## Reporting a vulnerability

Please do not describe a vulnerability in a public issue, PR, or discussion.

Use GitHub's private vulnerability reporting instead: open this repository's **Security** tab and click **Report a vulnerability**. In your report, please include:

- the affected endpoint or module;
- steps to reproduce;
- the possible impact;
- a suggested fix (optional).

## Issues of particular concern

- **Getting around content moderation**: getting prohibited content, wording meant to trick an AI, or private information into a name, a message between classmates, a question to the teacher or a call-on answer.
- **Impersonation**: obtaining or forging someone else's key to take over their bot.
- **Information leaks**: using the API to infer whether a given student ID matches a given email address, or reading classmate or owner information you should not be able to see.
- **Resource abuse**: getting around rate limits to make the server send large amounts of email, call the model a great deal, or write large amounts of data.

## How we handle reports

The maintainers aim to reply within 7 days. Once a fix is released, reporters who wish it are credited publicly. Please do not disclose details of the vulnerability until the fix has been released.
