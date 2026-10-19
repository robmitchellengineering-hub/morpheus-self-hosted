INSERT INTO deck_widget_instances (created_by_id, widget_key, enabled, sort_order)
SELECT id, 'jarvis_suggestions', true, -1
FROM users
WHERE users.email = 'info@valiantmusic.com.au'
ON CONFLICT (created_by_id, widget_key) DO NOTHING;
