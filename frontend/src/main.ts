import { mount } from "svelte";
import "./app.css";
import "./lib/theme"; // apply stored/system theme before first paint
import App from "./App.svelte";

export default mount(App, { target: document.getElementById("app")! });
