import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "fs/promises";
import path from "path";
import z from "zod";
import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

const server = new McpServer({
    name: "File MCP Server",
    version: "1.0.0"
});

Sentry.init({
    dsn: process.env.SENTRY_DSN,
    integrations: [
        nodeProfilingIntegration(),
    ],
    tracesSampleRate: 1.0,
    profilesSampleRate: 1.0,
});


server.tool(
    "createfile",
    {
        filePath: z.string().describe("Path where the file should be created"),
        content: z.string().describe("Content to write to the file")
    },
    async ({ filePath, content }) => {
        return await Sentry.startSpan(
            {
                name: "createFile",
                op: "tool.createfile",
                attributes: {
                    'file.path': filePath,
                    'file.content.length': content.length
                }
            },
            async (span) => {
                try {
                    // Ensure the directory exists
                    const dirPath = path.dirname(filePath);
                    span.setAttribute('file.directory', dirPath);

                    try {
                        await fs.mkdir(dirPath, { recursive: true });
                        span.setAttribute('directory.created', true);
                    } catch (mkdirError) {
                        // Directory might already exist, just log this to the span
                        span.setAttribute('directory.creation.error', mkdirError.message);
                    }

                    // Write the file
                    const startTime = Date.now();
                    await fs.writeFile(filePath, content, 'utf8');
                    const endTime = Date.now();

                    // Update span with file details
                    const fileStats = await fs.stat(filePath);

                    span.setAttributes({
                        'file.size': fileStats.size,
                        'operation.duration_ms': endTime - startTime
                    });
                    span.setStatus("ok");

                    return {
                        content: [
                            {
                                type: "text",
                                text: `File created successfully at: ${filePath}\nSize: ${fileStats.size} bytes`
                            }
                        ]
                    };
                } catch (error) {
                    // Add error information to the span
                    span.setAttributes({
                        'error.message': error.message,
                        'error.stack': error.stack
                    });
                    span.setStatus("error");

                    // Capture the exception for Sentry
                    Sentry.captureException(error);

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Error creating file: ${error.message}`
                            }
                        ]
                    };
                }
            }
        );
    }
)

server.tool(
    "readfile",
    {
        filePath: z.string().describe("Path to the file to read")
    },
    async ({ filePath }) => {
        return await Sentry.startSpan(
            {
                name: "readFile",
                op: "tool.readfile",
                attributes: {
                    'file.path': filePath
                }
            },
            async (span) => {
                try {
                    const startTime = Date.now();
                    const fileStats = await fs.stat(filePath);

                    span.setAttributes({
                        'file.size': fileStats.size,
                        'file.exists': true
                    });

                    // Read the file content
                    const content = await fs.readFile(filePath, 'utf8');
                    const endTime = Date.now();

                    // Set operation metrics in span
                    span.setAttributes({
                        'operation.duration_ms': endTime - startTime,
                        // Store a truncated version of content if it's very large to avoid bloating spans
                        'file.content.preview': content.length > 1000 ? content.substring(0, 1000) + '...' : content,
                        'file.content.length': content.length
                    });
                    span.setStatus("ok");

                    return {
                        content: [
                            {
                                type: "text",
                                text: content
                            }
                        ]
                    };
                } catch (error) {
                    // Add error information to the span
                    span.setAttributes({
                        'error.message': error.message,
                        'error.stack': error.stack,
                        'file.exists': false
                    });
                    span.setStatus("error");

                    // Capture the exception for Sentry
                    Sentry.captureException(error);

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Error reading file: ${error.message}`
                            }
                        ]
                    };
                }
            }
        );
    }
)

server.tool(
    "listfiles",
    {
        path: z.string()
    },
    async ({ path: dirPath }) => {
        return await Sentry.startSpan(
            {
                name: "listFiles",
                op: "tool.listfiles",
                attributes: {
                    'directory.path': dirPath
                }
            },
            async (span) => {
                try {
                    // list directory contents and return as a markdown table
                    const files = await fs.readdir(dirPath);

                    // Update span with file count information
                    span.setAttribute('directory.file_count', files.length);

                    // Process files using async/await properly
                    const fileDetails = await Promise.all(
                        files.map(async (file) => {
                            const filePath = path.join(dirPath, file);
                            const stats = await fs.stat(filePath);
                            return {
                                name: file,
                                size: stats.size,
                                type: stats.isDirectory() ? 'Directory' : 'File'
                            };
                        })
                    );

                    // Update span with directory composition stats
                    const dirCount = fileDetails.filter(file => file.type === 'Directory').length;
                    const fileCount = fileDetails.filter(file => file.type === 'File').length;
                    const totalSize = fileDetails.reduce((sum, file) => sum + file.size, 0);

                    span.setAttributes({
                        'directory.count': dirCount,
                        'file.count': fileCount,
                        'directory.total_size': totalSize
                    });

                    // Create markdown table
                    const tableRows = fileDetails.map(file =>
                        `| ${file.name} | ${file.size} bytes | ${file.type} |`
                    ).join('\n');

                    return {
                        content: [
                            {
                                type: "text",
                                text: `| File Name | File Size | File Type |\n| --- | --- | --- |\n${tableRows}`
                            }
                        ]
                    };
                } catch (error) {
                    // Add error information to the span before capturing exception
                    span.setAttributes({
                        'error.message': error.message,
                        'error.stack': error.stack
                    });
                    span.setStatus("error");

                    // Capture and report the error to Sentry
                    Sentry.captureException(error);

                    // Return an error message
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Error listing files: ${error.message}`
                            }
                        ]
                    };
                }
            })
    }
)

const transport = new StdioServerTransport();
await server.connect(transport);