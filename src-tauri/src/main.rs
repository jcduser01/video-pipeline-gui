// Prevents an extra console window on Windows in release. Mac-first, but kept
// for portability per the SADD's re-evaluation trigger.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    video_pipeline_gui_lib::run();
}
