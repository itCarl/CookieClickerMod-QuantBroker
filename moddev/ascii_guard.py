"""
Keeps main.js pure ASCII.

The game's index.html declares no <meta charset>, and mod scripts are injected
with document.createElement('script'), so a UTF-8 multibyte character in the
source can be misdecoded at load time. Any non-ASCII character is therefore
rewritten as a \\uXXXX JavaScript escape, which is always safe.

    python dev/ascii_guard.py [--check]
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(os.path.dirname(HERE), "main.js")


def main():
    check_only = "--check" in sys.argv
    text = open(TARGET, encoding="utf-8").read()

    offenders = sorted({ch for ch in text if ord(ch) > 127})
    if not offenders:
        print("main.js is already pure ASCII")
        return 0

    if check_only:
        print("non-ASCII characters present: " + " ".join(
            "U+%04X" % ord(c) for c in offenders))
        return 1

    escaped = "".join(
        ch if ord(ch) < 128 else "\\u%04x" % ord(ch)
        for ch in text
    )
    open(TARGET, "w", encoding="ascii", newline="\n").write(escaped)

    print("escaped %d distinct non-ASCII characters: %s" % (
        len(offenders), " ".join("U+%04X" % ord(c) for c in offenders)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
