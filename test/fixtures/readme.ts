// A fake governance README with the real shape (headings, Notion's <table> HTML, fake IDs).
export const AL_ID = "11111111-1111-1111-1111-111111111111";
export const PREFS_ID = "22222222-2222-2222-2222-222222222222";
export const GUIDE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const LONG_A_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const LONG_B_ID = "cccccccccccccccccccccccccccccccc";

export const README_MD = `# README

## Start
1. Read this page.

## Ask first
<table header-row="true">
<tr>
<td>Action</td>
<td>Why</td>
</tr>
<tr>
<td>[Activity Log](https://app.notion.com/p/99999999999999999999999999999999)</td>
<td>not the store table</td>
</tr>
</table>

## Where things go
<table header-row="true">
<tr>
<td>What</td>
<td>Where</td>
<td>Data source</td>
<td>Notes</td>
</tr>
<tr>
<td>A record of agent work</td>
<td>[Activity Log](https://app.notion.com/p/33333333333333333333333333333333)</td>
<td>\`collection://${AL_ID}\`</td>
<td>one row per task</td>
</tr>
<tr>
<td>A standing preference</td>
<td>[Preferences](https://app.notion.com/p/44444444444444444444444444444444)</td>
<td>\`collection://${PREFS_ID}\`</td>
<td></td>
</tr>
</table>

## Guides
<table header-row="true">
<tr>
<td>Guide</td>
<td>Open it when you're about to…</td>
</tr>
<tr>
<td>[Tool Guide](https://app.notion.com/p/${GUIDE_ID})</td>
<td>call a Notion tool</td>
</tr>
<tr>
<td>[Long Guide A](https://app.notion.com/p/${LONG_A_ID})</td>
<td>test a bundle over the reply cap</td>
</tr>
<tr>
<td>[Long Guide B](https://app.notion.com/p/${LONG_B_ID})</td>
<td>test a bundle over the reply cap</td>
</tr>
</table>

## Logging
Log every task.
`;
