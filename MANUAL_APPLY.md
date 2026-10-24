# V1.6 人工套用候選檔

1. 執行 `node agent-v1.mjs`，閱讀提案後輸入 `APPROVE`。
2. QA、TypeScript 與正式檔完整性檢查全部通過後，程式產生本機 manifest，綁定候選檔與原正式檔的 SHA-256。
3. 執行 `node apply-candidate.mjs`。工具重新檢查型別並顯示差異。
4. 確認後輸入畫面上完整的 `APPLY <SHA-256>`。任何其他輸入都會取消。
5. 成功時顯示 `APPLIED`、備份位置與新正式檔雜湊。工具不執行 Git 提交。

`allowAutoWrite` 保持 false；獨立的 `allowManualApply: true` 只允許此人工確認流程。要停用套用，將後者設為 false。

舊候選檔沒有 manifest，必須重新走生成與驗證流程；不應手動建立 manifest。manifest 是本機驗證紀錄，不是簽章，不能防止擁有本機寫入權限的人同時竄改紀錄與程式。

套用前會備份原始位元組至 Agent 的 `backups/`，先以同目錄暫存檔寫入，再重新命名取代正式檔。套用後驗證失敗會還原；若發現外部修改，會保留外部修改並回報備份位置，不強制覆寫。程式拒絕連結路徑。執行期間請先停止其他會寫入目標檔案的工具；本機鎖只能協調本工具，無法排除其他編輯器在最後雜湊比對與重新命名之間寫入。

若程式被強制終止，可能保留 `candidates/manual-apply.lock` 或 `.aios-*.tmp`。請先確認沒有套用程序在執行，核對正式檔與備份後再處理殘留檔案。此工具沒有自動處理斷電恢復。

測試：`node manual-apply.test.mjs` 與 `node candidate-typecheck.test.mjs`。
型別檢查通過不代表 Next.js build、頁面功能或無障礙驗證通過。
