/**
 * Text that is safe to print.
 *
 * Everything here exists because this library quotes its input back: an evidence
 * summary names the path that was requested and the header that was sent, and an actor
 * label is whatever an operator typed. That text is then written to a log file, a
 * terminal and a JSON feed — three readers that treat some characters as instructions
 * rather than as letters.
 */

/**
 * The longest a summary may be. Every built-in detector writes something far shorter;
 * the cap is here for detectors this library did not write, so one of them cannot put
 * a megabyte of request body into every log line and every dashboard row.
 */
const SUMMARY_CHARS = 512;

/**
 * Makes one line of prose safe to print.
 *
 * Evidence summaries name what was seen, and naming it often means quoting the client:
 * the path it asked for, the header it sent, the identity it claimed. That text is
 * written by whoever sent the request, and it lands in three places that read control
 * characters as instructions rather than as letters — a log file, where a carriage
 * return and a newline let a client forge a second log line of its own composition; a
 * terminal, where an escape sequence repaints or erases what is already on screen; and
 * a JSON feed, where a lone surrogate is not encodable.
 *
 * So the characters that mean something other than themselves are replaced with U+FFFD
 * and the text is capped. What a client says about itself is quoted, never obeyed.
 *
 * The scan allocates nothing and returns the original string when there is nothing to
 * fix, which is every request that is not an attack: this runs on every piece of
 * evidence on every request.
 */
export function safeSummary(text: string): string {
  let flawed = text.length > SUMMARY_CHARS;
  if (!flawed) {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      // C0, DEL and C1 are the ranges a terminal or a log reader acts on. A lone
      // surrogate is not a character at all and does not survive being encoded.
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff)) {
        flawed = true;
        break;
      }
    }
  }
  if (!flawed) return text;

  let out = "";
  const limit = Math.min(text.length, SUMMARY_CHARS);
  for (let i = 0; i < limit; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += "�";
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // A well-formed pair is a real character and is kept whole; a lone half is not.
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i]! + text[i + 1]!;
        i++;
      } else out += "�";
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += "�";
    } else out += text[i]!;
  }
  return text.length > SUMMARY_CHARS ? `${out}…` : out;
}
