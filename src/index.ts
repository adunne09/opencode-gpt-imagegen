import { basename } from "node:path"
import { pathToFileURL } from "node:url"
import { Plugin } from "@opencode-ai/plugin"
import { callViaCodexResponses } from "./codex"
import { readReferenceImages } from "./input-image"
import { saveGeneratedImage } from "./output-image"
import type { GenerateArgs, OpenAIAuth } from "./types"

const input = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "Description of the image to generate." },
    out: {
      type: "string",
      description: "Output file path, relative to the project directory unless absolute. The plugin writes a PNG.",
    },
    quality: {
      type: "string",
      enum: ["low", "medium", "high", "auto"],
      description: "Generation quality passed to the hosted image_generation tool.",
    },
    size: {
      type: "string",
      description:
        "Optional image size passed to the hosted image_generation tool. Use `auto` or `WIDTHxHEIGHT`; width and height must be multiples of 16px, max edge <= 3840px, long-to-short ratio <= 3:1, and total pixels between 655,360 and 8,294,400.",
    },
    images: {
      type: "array",
      items: { type: "string" },
      description: "Optional reference image paths, relative to the project directory unless absolute.",
    },
  },
  required: ["prompt", "out", "quality"],
  additionalProperties: false,
} as const

export default Plugin.define({
  id: "opencode-gpt-imagegen",
  async setup(ctx) {
    await ctx.tool.transform((draft) => {
      draft.add({
        name: "gpt_imagegen",
        description: [
          "Generate raster images using OpenAI's hosted image_generation tool.",
          "Use for AI-created bitmap visuals such as photos, illustrations, textures, sprites, and mockups.",
          "Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas.",
          "Reference images may be attached through `images`; label each image's role inline in `prompt`, for example: 'Image 1: reference image'.",
          "For many distinct assets, invoke gpt_imagegen once per requested asset rather than relying on multi-image output; gpt_imagegen returns one image per call.",
          "Requires OpenCode to be authenticated with ChatGPT OAuth. Returns the generated PNG as an attachment.",
        ].join(" "),
        input,
        async execute(raw, tool) {
          const args = raw as GenerateArgs
          const connection = await ctx.integration.connection.active("openai")
          const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined
          if (credential?.type !== "oauth") {
            throw new Error("OpenAI ChatGPT OAuth credentials not configured.")
          }

          const metadata = credential.metadata
          const accountId =
            typeof metadata?.accountId === "string"
              ? metadata.accountId
              : typeof metadata?.account_id === "string"
                ? metadata.account_id
                : undefined
          const auth: OpenAIAuth = { type: "oauth", access: credential.access, accountId }
          const session = await ctx.session.get({ sessionID: tool.sessionID })
          const directory = session.location.directory
          const inputImageDataUrls = await readReferenceImages(args.images, directory)
          const base64 = await callViaCodexResponses(auth, args, inputImageDataUrls)
          const { savedPath, versioned, message } = await saveGeneratedImage(args.out, directory, base64)

          return {
            content: [
              { type: "text", text: message },
              {
                type: "file",
                uri: pathToFileURL(savedPath).href,
                mime: "image/png",
                name: basename(savedPath),
              },
            ],
            metadata: {
              out: savedPath,
              versioned,
              billing: "subscription",
            },
          }
        },
      })
    })
  },
})
