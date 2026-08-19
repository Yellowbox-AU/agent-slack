import { describe, expect, test } from "bun:test";
import { parseInlineElements, textToRichTextBlocks } from "../src/slack/rich-text.ts";

describe("parseInlineElements", () => {
  test("plain text returns single text element", () => {
    expect(parseInlineElements("Hello world")).toEqual([{ type: "text", text: "Hello world" }]);
  });

  test("*bold* is parsed with bold style", () => {
    expect(parseInlineElements("Hello *world*!")).toEqual([
      { type: "text", text: "Hello " },
      { type: "text", text: "world", style: { bold: true } },
      { type: "text", text: "!" },
    ]);
  });

  test("_italic_ is parsed with italic style", () => {
    expect(parseInlineElements("This is _important_")).toEqual([
      { type: "text", text: "This is " },
      { type: "text", text: "important", style: { italic: true } },
    ]);
  });

  test("~strike~ is parsed with strike style", () => {
    expect(parseInlineElements("~done~")).toEqual([
      { type: "text", text: "done", style: { strike: true } },
    ]);
  });

  test("`code` is parsed with code style", () => {
    expect(parseInlineElements("Run `npm install`")).toEqual([
      { type: "text", text: "Run " },
      { type: "text", text: "npm install", style: { code: true } },
    ]);
  });

  test("<url|label> is parsed as link with text", () => {
    expect(parseInlineElements("Visit <https://example.com|Example>")).toEqual([
      { type: "text", text: "Visit " },
      { type: "link", url: "https://example.com", text: "Example" },
    ]);
  });

  test("<url> is parsed as link without text", () => {
    expect(parseInlineElements("See <https://example.com>")).toEqual([
      { type: "text", text: "See " },
      { type: "link", url: "https://example.com" },
    ]);
  });

  test("non-url angle bracket text is preserved as text", () => {
    expect(parseInlineElements("Use <fix>")).toEqual([
      { type: "text", text: "Use " },
      { type: "text", text: "<fix>" },
    ]);
  });
});

/**
 * Emphasis spans are parsed recursively, so an entity inside one becomes a real
 * element carrying the span style. Every expectation here was checked
 * field-for-field against Slack's own server-side parse of the same text
 * (12-shape probe posted raw and read back as blocks JSON).
 */
describe("parseInlineElements: entities inside emphasis spans", () => {
  test("mention at the start of a bold span", () => {
    expect(parseInlineElements("*<@U0712TLA459> hi*")).toEqual([
      { type: "user", user_id: "U0712TLA459", style: { bold: true } },
      { type: "text", text: " hi", style: { bold: true } },
    ]);
  });

  test("mention at the end of a bold span", () => {
    expect(parseInlineElements("*hi <@U0712TLA459>*")).toEqual([
      { type: "text", text: "hi ", style: { bold: true } },
      { type: "user", user_id: "U0712TLA459", style: { bold: true } },
    ]);
  });

  test("mention mid-span", () => {
    expect(parseInlineElements("*a <@U0712TLA459> b*")).toEqual([
      { type: "text", text: "a ", style: { bold: true } },
      { type: "user", user_id: "U0712TLA459", style: { bold: true } },
      { type: "text", text: " b", style: { bold: true } },
    ]);
  });

  test("a fully bolded mention is a single styled user element", () => {
    expect(parseInlineElements("*<@U0712TLA459>*")).toEqual([
      { type: "user", user_id: "U0712TLA459", style: { bold: true } },
    ]);
  });

  test("mention inside an italic span", () => {
    expect(parseInlineElements("_a <@U0712TLA459> b_")).toEqual([
      { type: "text", text: "a ", style: { italic: true } },
      { type: "user", user_id: "U0712TLA459", style: { italic: true } },
      { type: "text", text: " b", style: { italic: true } },
    ]);
  });

  test("mention inside a strike span", () => {
    expect(parseInlineElements("~a <@U0712TLA459> b~")).toEqual([
      { type: "text", text: "a ", style: { strike: true } },
      { type: "user", user_id: "U0712TLA459", style: { strike: true } },
      { type: "text", text: " b", style: { strike: true } },
    ]);
  });

  test("labelled link inside a bold span", () => {
    expect(parseInlineElements("*see <https://example.com|Example> now*")).toEqual([
      { type: "text", text: "see ", style: { bold: true } },
      { type: "link", url: "https://example.com", text: "Example", style: { bold: true } },
      { type: "text", text: " now", style: { bold: true } },
    ]);
  });

  test("bare link inside a bold span", () => {
    expect(parseInlineElements("*a <https://example.com> b*")).toEqual([
      { type: "text", text: "a ", style: { bold: true } },
      { type: "link", url: "https://example.com", style: { bold: true } },
      { type: "text", text: " b", style: { bold: true } },
    ]);
  });

  test("broadcast inside a bold span", () => {
    expect(parseInlineElements("*ping <!here> now*")).toEqual([
      { type: "text", text: "ping ", style: { bold: true } },
      { type: "broadcast", range: "here", style: { bold: true } },
      { type: "text", text: " now", style: { bold: true } },
    ]);
  });

  test("nested spans merge styles rather than overwrite", () => {
    expect(parseInlineElements("*a _b <@U0712TLA459> c_ d*")).toEqual([
      { type: "text", text: "a ", style: { bold: true } },
      { type: "text", text: "b ", style: { bold: true, italic: true } },
      { type: "user", user_id: "U0712TLA459", style: { bold: true, italic: true } },
      { type: "text", text: " c", style: { bold: true, italic: true } },
      { type: "text", text: " d", style: { bold: true } },
    ]);
  });

  test("a span with no entity is unchanged", () => {
    expect(parseInlineElements("*just bold*")).toEqual([
      { type: "text", text: "just bold", style: { bold: true } },
    ]);
  });

  test("an emphasis marker opens after a mention or link token", () => {
    expect(parseInlineElements("<@U0712TLA459>*alpha*")).toEqual([
      { type: "user", user_id: "U0712TLA459" },
      { type: "text", text: "alpha", style: { bold: true } },
    ]);
  });

  test("intra-word underscores are not italics", () => {
    expect(parseInlineElements("thread_ts and <@U0712TLA459> checked message_ts")).toEqual([
      { type: "text", text: "thread_ts and " },
      { type: "user", user_id: "U0712TLA459" },
      { type: "text", text: " checked message_ts" },
    ]);
  });

  test("arithmetic asterisks are not bold", () => {
    expect(parseInlineElements("2*3 <@U0712TLA459> 4*5")).toEqual([
      { type: "text", text: "2*3 " },
      { type: "user", user_id: "U0712TLA459" },
      { type: "text", text: " 4*5" },
    ]);
  });

  test("a stray marker does not pair across a newline", () => {
    expect(parseInlineElements("*stray and <@U0712TLA459>\nnext line*")).toEqual([
      { type: "text", text: "*stray and " },
      { type: "user", user_id: "U0712TLA459" },
      { type: "text", text: "\nnext line*" },
    ]);
  });

  test("incident message, first mention site", () => {
    expect(
      parseInlineElements("*<@U0712TLA459> — for the firewall doc, the two highlighted rows:*"),
    ).toEqual([
      { type: "user", user_id: "U0712TLA459", style: { bold: true } },
      {
        type: "text",
        text: " — for the firewall doc, the two highlighted rows:",
        style: { bold: true },
      },
    ]);
  });

  test("incident message, second mention site", () => {
    expect(parseInlineElements("*<@U09LLG77TU3>* — one improvement")).toEqual([
      { type: "user", user_id: "U09LLG77TU3", style: { bold: true } },
      { type: "text", text: " — one improvement" },
    ]);
  });

  test("channel ref with a label is a channel element, not a link", () => {
    expect(parseInlineElements("see <#C0AKNUXTVK6|roche-usa> now")).toEqual([
      { type: "text", text: "see " },
      { type: "channel", channel_id: "C0AKNUXTVK6" },
      { type: "text", text: " now" },
    ]);
  });

  test("channel ref without a label is a channel element", () => {
    expect(parseInlineElements("see <#C0AKNUXTVK6> now")).toEqual([
      { type: "text", text: "see " },
      { type: "channel", channel_id: "C0AKNUXTVK6" },
      { type: "text", text: " now" },
    ]);
  });

  test("channel ref inside a bold span carries the style", () => {
    expect(parseInlineElements("*see <#C0AKNUXTVK6|roche-usa> now*")).toEqual([
      { type: "text", text: "see ", style: { bold: true } },
      { type: "channel", channel_id: "C0AKNUXTVK6", style: { bold: true } },
      { type: "text", text: " now", style: { bold: true } },
    ]);
  });

  test("code span inside a bold span keeps both styles", () => {
    expect(parseInlineElements("*a `code` b*")).toEqual([
      { type: "text", text: "a ", style: { bold: true } },
      { type: "text", text: "code", style: { bold: true, code: true } },
      { type: "text", text: " b", style: { bold: true } },
    ]);
  });

  test("a doubled marker is literal text, as on Slack's own parser", () => {
    expect(parseInlineElements("**bold**")).toEqual([{ type: "text", text: "**bold**" }]);
    expect(parseInlineElements("this is **not** ok")).toEqual([
      { type: "text", text: "this is **not** ok" },
    ]);
    expect(parseInlineElements("***triple***")).toEqual([{ type: "text", text: "***triple***" }]);
  });

  test("a marker glued to a word on either side is literal text", () => {
    expect(parseInlineElements("a*b*c")).toEqual([{ type: "text", text: "a*b*c" }]);
    expect(parseInlineElements("*a*b")).toEqual([{ type: "text", text: "*a*b" }]);
  });

  test("a marker opens after a bare > as well", () => {
    expect(parseInlineElements("x>*y*")).toEqual([
      { type: "text", text: "x>" },
      { type: "text", text: "y", style: { bold: true } },
    ]);
  });

  test("the agent attribution prefix keeps both bold runs and the link", () => {
    expect(
      parseInlineElements("*Agent*<https://arb.localhost/s/1|session>*Update [claude]*: hi"),
    ).toEqual([
      { type: "text", text: "Agent", style: { bold: true } },
      { type: "link", url: "https://arb.localhost/s/1", text: "session" },
      { type: "text", text: "Update [claude]", style: { bold: true } },
      { type: "text", text: ": hi" },
    ]);
  });
});

describe("textToRichTextBlocks", () => {
  test("plain text returns null", () => {
    expect(textToRichTextBlocks("Hello world")).toBeNull();
  });

  test("inline-only formatting returns null by default", () => {
    expect(textToRichTextBlocks("Visit <https://example.com|Example>")).toBeNull();
  });

  test("non-url angle bracket text does not trigger rich text blocks", () => {
    expect(textToRichTextBlocks("Use <fix>", { includeInlineFormatting: true })).toBeNull();
  });

  test("mixed non-url angle bracket text and formatting preserves brackets", () => {
    const result = textToRichTextBlocks("Use <fix> and *bold*", {
      includeInlineFormatting: true,
    })!;
    expect(result[0]!.elements).toEqual([
      {
        type: "rich_text_section",
        elements: [
          { type: "text", text: "Use " },
          { type: "text", text: "<fix>" },
          { type: "text", text: " and " },
          { type: "text", text: "bold", style: { bold: true } },
          { type: "text", text: "\n" },
        ],
      },
    ]);
  });

  test("inline-only formatting can produce rich text blocks", () => {
    const result = textToRichTextBlocks("Visit <https://example.com|Example>", {
      includeInlineFormatting: true,
    })!;
    expect(result).not.toBeNull();
    expect(result[0]!.elements).toEqual([
      {
        type: "rich_text_section",
        elements: [
          { type: "text", text: "Visit " },
          { type: "link", url: "https://example.com", text: "Example" },
          { type: "text", text: "\n" },
        ],
      },
    ]);
  });

  test("bullet list with - prefix", () => {
    const result = textToRichTextBlocks("- Item 1\n- Item 2\n- Item 3")!;
    expect(result).not.toBeNull();
    const lists = result[0]!.elements.filter((e) => e.type === "rich_text_list");
    expect(lists).toHaveLength(1);
    const list = lists[0]!;
    expect(list.type === "rich_text_list" && list.elements).toHaveLength(3);
  });

  test("bullet list with bullet character", () => {
    expect(textToRichTextBlocks("• Item 1\n• Item 2")).not.toBeNull();
  });

  test("sub-bullets with indentation", () => {
    const result = textToRichTextBlocks("- Main 1\n- Main 2\n  - Sub 2a\n  - Sub 2b\n- Main 3")!;
    expect(result).not.toBeNull();
    const lists = result[0]!.elements.filter((e) => e.type === "rich_text_list");
    expect(lists).toHaveLength(3); // main, sub, main
    expect((lists[1] as { indent?: number }).indent).toBe(1);
  });

  test("white bullet sub-bullets under bullet", () => {
    const result = textToRichTextBlocks("• Top level\n  ◦ Sub-bullet\n  ◦ Another sub")!;
    expect(result).not.toBeNull();
    const lists = result[0]!.elements.filter((e) => e.type === "rich_text_list");
    expect(lists).toHaveLength(2);
    expect((lists[1] as { indent?: number }).indent).toBe(1);
  });

  test("mixed text and bullets", () => {
    const result = textToRichTextBlocks("Here is a list:\n- Item 1\n- Item 2")!;
    expect(result).not.toBeNull();
    expect(result[0]!.elements[0]!.type).toBe("rich_text_section");
    expect(result[0]!.elements[1]!.type).toBe("rich_text_list");
  });

  test("numbered list", () => {
    const result = textToRichTextBlocks("1. First\n2. Second\n3. Third")!;
    expect(result).not.toBeNull();
    const list = result[0]!.elements.find((e) => e.type === "rich_text_list")!;
    expect((list as { style: string }).style).toBe("ordered");
  });

  test("bold text in list items is parsed", () => {
    const result = textToRichTextBlocks("- *Bold item*\n- Normal item")!;
    expect(result).not.toBeNull();
    const list = result[0]!.elements.find((e) => e.type === "rich_text_list") as {
      elements: { elements: unknown[] }[];
    };
    expect(list.elements[0]!.elements).toEqual([
      { type: "text", text: "Bold item", style: { bold: true } },
    ]);
  });

  test("code block is preserved", () => {
    const result = textToRichTextBlocks("- Item\n```\ncode here\n```")!;
    expect(result).not.toBeNull();
    expect(result[0]!.elements.find((e) => e.type === "rich_text_preformatted")).toBeDefined();
  });

  test("blockquote is preserved", () => {
    const result = textToRichTextBlocks("- Item\n> quoted text")!;
    expect(result).not.toBeNull();
    expect(result[0]!.elements.find((e) => e.type === "rich_text_quote")).toBeDefined();
  });
});
