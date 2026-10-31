// Sem janela de console no Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|a| a == "--instalar-teste") {
        std::process::exit(jarvis_launcher_lib::instalar_sem_janela());
    }
    jarvis_launcher_lib::run()
}
