-- The prompt note (`@ai` handwriting) that started a thread, so every device shows the note as done.
ALTER TABLE ai_threads ADD COLUMN source_note TEXT;
