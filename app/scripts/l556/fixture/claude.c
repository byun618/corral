/* LIFE-556 fix1 M1 — stand-in provider for the B8 round trip. Never a real model.
 * Named `claude` so the pane's foreground process carries that name; draws what herdr's claude
 * manifest reads as idle (OSC title "✳ …" and a "❯" prompt box), takes the submitted body in raw
 * mode, and once input has been quiet for 1.5 s after "=== TASK ===" hands it to report.py, which
 * records the body the way claude does (one human row in $HOME/.claude/projects/<cwd>/<session>.jsonl —
 * the isolated HOME, never the user's) and runs the preamble's own worker_done command from inside this pane. Output goes to
 * $L556_FIXTURE_OUT (body + report). Build: cc -O2 -o claude claude.c */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>
#include <sys/select.h>

static void idle_screen(void) {
  printf("\033]0;\xE2\x9C\xB3 Claude Code\007");
  printf("\r\n\xE2\x95\xAD"); for (int i = 0; i < 40; i++) printf("\xE2\x94\x80"); printf("\xE2\x95\xAE\r\n");
  printf("\xE2\x94\x82 \xE2\x9D\xAF                                      \xE2\x94\x82\r\n");
  printf("\xE2\x95\xB0"); for (int i = 0; i < 40; i++) printf("\xE2\x94\x80"); printf("\xE2\x95\xAF\r\n");
  printf("  ? for shortcuts\r\n");
  fflush(stdout);
}

int main(int argc, char **argv) {
  const char *session = "";
  for (int i = 1; i + 1 < argc; i++) if (strcmp(argv[i], "--session-id") == 0) session = argv[i + 1];
  const char *out = getenv("L556_FIXTURE_OUT");
  const char *script = getenv("L556_FIXTURE_REPORT");
  if (out == NULL || script == NULL) { fprintf(stderr, "L556_FIXTURE_OUT/REPORT unset\n"); return 2; }
  struct termios raw; tcgetattr(0, &raw); cfmakeraw(&raw); tcsetattr(0, TCSANOW, &raw);
  idle_screen();
  size_t cap = 1 << 20, len = 0; char *buf = malloc(cap); int done = 0;
  for (;;) {
    fd_set set; FD_ZERO(&set); FD_SET(0, &set);
    struct timeval wait = { 1, 500000 };
    int ready = select(1, &set, NULL, NULL, &wait);
    if (ready > 0) {
      ssize_t n = read(0, buf + len, cap - len - 1);
      if (n <= 0) break;
      len += (size_t)n; buf[len] = 0;
      continue;
    }
    if (!done && len > 0 && strstr(buf, "=== TASK ===") != NULL) {
      done = 1;
      FILE *f = fopen(out, "wb"); if (f) { fwrite(buf, 1, len, f); fclose(f); }
      char cmd[4096]; snprintf(cmd, sizeof cmd, "/usr/bin/python3 '%s' '%s' '%s' > '%s.report' 2>&1", script, out, session, out);
      int rc = system(cmd);
      FILE *r = fopen(out, "ab"); if (r) { fprintf(r, "\n--- report exit %d\n", rc); fclose(r); }
      idle_screen();
    }
  }
  return 0;
}
