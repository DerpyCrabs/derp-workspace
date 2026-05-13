#!/usr/bin/env bash
set -euo pipefail

checkout_root="${CARGO_HOME:-$HOME/.cargo}/git/checkouts"
registry_root="${CARGO_HOME:-$HOME/.cargo}/registry/src"
mod_files=()
while IFS= read -r file; do
  mod_files+=("$file")
done < <(find "$checkout_root" -path '*/smithay-*/5312d5c*/src/wayland/input_method/mod.rs' -type f 2>/dev/null | sort)
if [[ ${#mod_files[@]} -eq 0 ]]; then
  echo "patch-smithay-shell-osk: smithay checkout 5312d5c not found under $checkout_root" >&2
  exit 1
fi

for mod_file in "${mod_files[@]}"; do
  handle_file="${mod_file%/mod.rs}/input_method_handle.rs"
  [[ -f "$handle_file" ]] || continue
  if ! grep -q 'commit_string_without_text_input' "$mod_file"; then
    perl -0pi -e 's/(    fn parent_geometry\(&self, parent: &WlSurface\) -> Rectangle<i32, Logical>;\n)/$1\n    fn commit_string_without_text_input\(&mut self, text: String\) -> bool {\n        let _ = text;\n        false\n    }\n/s' "$mod_file"
  fi
  if ! grep -q 'activate_input_method_without_text_input' "$mod_file"; then
    perl -0pi -e 's#pub trait InputMethodSeat \{\n    ///#pub trait InputMethodSeat {\n    fn activate_input_method_without_text_input(&self) {\n        self.input_method().activate_input_method_without_text_input();\n    }\n\n    fn deactivate_input_method_without_text_input(&self) {\n        self.input_method().deactivate_input_method_without_text_input();\n    }\n\n    ///#s' "$mod_file"
  fi
  if ! grep -q 'input_method_without_text_input_should_activate' "$mod_file"; then
    perl -0pi -e 's#(    fn commit_string_without_text_input\(&mut self, text: String\) -> bool \{\n        let _ = text;\n        false\n    \}\n)#$1\n    fn input_method_without_text_input_should_activate(&self) -> bool {\n        false\n    }\n#s' "$mod_file"
  fi
  if ! grep -q 'zwp_text_input_v3::{ChangeCause, ContentHint, ContentPurpose}' "$handle_file"; then
    perl -0pi -e 's#use wayland_protocols_misc::zwp_input_method_v2::server::\{#use wayland_protocols::wp::text_input::zv3::server::zwp_text_input_v3::{ChangeCause, ContentHint, ContentPurpose};\nuse wayland_protocols_misc::zwp_input_method_v2::server::{#s' "$handle_file"
  fi
  if ! grep -q 'pub(crate) fn activate_input_method_without_text_input' "$handle_file"; then
    perl -0pi -e 's#    /// Callback function to access the input method object#    pub(crate) fn activate_input_method_without_text_input(&self) {\n        self.with_input_method(|im| {\n            if let Some(instance) = im.instance.as_mut() {\n                instance.object.activate();\n                instance.object.surrounding_text(String::new(), 0, 0);\n                instance.object.text_change_cause(ChangeCause::InputMethod);\n                instance.object.content_type(ContentHint::empty(), ContentPurpose::Normal);\n                instance.done();\n            }\n        });\n    }\n\n    pub(crate) fn deactivate_input_method_without_text_input(&self) {\n        self.with_input_method(|im| {\n            if let Some(instance) = im.instance.as_mut() {\n                instance.object.deactivate();\n                instance.done();\n            }\n        });\n    }\n\n    /// Callback function to access the input method object#s' "$handle_file"
  fi
  if ! grep -q 'ContentPurpose::Normal' "$handle_file"; then
    perl -0pi -e 's#                instance\.object\.activate\(\);\n                instance\.done\(\);#                instance.object.activate();\n                instance.object.surrounding_text(String::new(), 0, 0);\n                instance.object.text_change_cause(ChangeCause::InputMethod);\n                instance.object.content_type(ContentHint::empty(), ContentPurpose::Normal);\n                instance.done();#s' "$handle_file"
  fi
  if grep -q 'im\.instance\.as_ref()' "$handle_file"; then
    perl -0pi -e 's#            if let Some\(instance\) = im\.instance\.as_ref\(\) \{\n                instance\.object\.activate\(\);\n            \}#            if let Some(instance) = im.instance.as_mut() {\n                instance.object.activate();\n                instance.object.surrounding_text(String::new(), 0, 0);\n                instance.object.text_change_cause(ChangeCause::InputMethod);\n                instance.object.content_type(ContentHint::empty(), ContentPurpose::Normal);\n                instance.done();\n            }#s' "$handle_file"
  fi
  if ! grep -q 'let shell_input_method_active = state.input_method_without_text_input_should_activate();' "$handle_file"; then
    perl -0pi -e 's/            zwp_input_method_v2::Request::CommitString \{ text \} => \{\n                data\.text_input_handle\.with_active_text_input\(\|ti, _surface\| \{\n                    ti\.commit_string\(Some\(text\.clone\(\)\)\);\n                \}\);\n            \}/            zwp_input_method_v2::Request::CommitString { text } => {\n                let shell_input_method_active = state.input_method_without_text_input_should_activate();\n                let mut committed_to_text_input = false;\n                if !shell_input_method_active {\n                    data.text_input_handle.with_active_text_input(|ti, _surface| {\n                        committed_to_text_input = true;\n                        ti.commit_string(Some(text.clone()));\n                    });\n                }\n                if shell_input_method_active || !committed_to_text_input {\n                    let _ = state.commit_string_without_text_input(text);\n                }\n            }/s' "$handle_file"
  fi
  perl -0pi -e 's#                let mut committed_to_text_input = false;\n                data\.text_input_handle\.with_active_text_input\(\|ti, _surface\| \{\n                    committed_to_text_input = true;\n                    ti\.commit_string\(Some\(text\.clone\(\)\)\);\n                \}\);\n                if !committed_to_text_input \{\n                    let _ = state\.commit_string_without_text_input\(text\);\n                \}#                let shell_input_method_active = state.input_method_without_text_input_should_activate();\n                let mut committed_to_text_input = false;\n                if !shell_input_method_active {\n                    data.text_input_handle.with_active_text_input(|ti, _surface| {\n                        committed_to_text_input = true;\n                        ti.commit_string(Some(text.clone()));\n                    });\n                }\n                if shell_input_method_active || !committed_to_text_input {\n                    let _ = state.commit_string_without_text_input(text);\n                }#s' "$handle_file"
  if ! grep -q 'shell_preedit_input_method_active' "$handle_file"; then
    perl -0pi -e 's#            zwp_input_method_v2::Request::SetPreeditString \{\n                text,\n                cursor_begin,\n                cursor_end,\n            \} => \{\n                data\.text_input_handle\.with_active_text_input\(\|ti, _surface\| \{\n                    ti\.preedit_string\(Some\(text\.clone\(\)\), cursor_begin, cursor_end\);\n                \}\);\n            \}#            zwp_input_method_v2::Request::SetPreeditString {\n                text,\n                cursor_begin,\n                cursor_end,\n            } => {\n                let shell_preedit_input_method_active = state.input_method_without_text_input_should_activate();\n                if shell_preedit_input_method_active {\n                    let _ = state.commit_string_without_text_input(text);\n                } else {\n                    data.text_input_handle.with_active_text_input(|ti, _surface| {\n                        ti.preedit_string(Some(text.clone()), cursor_begin, cursor_end);\n                    });\n                }\n            }#s' "$handle_file"
  fi
  if ! grep -q '_state.input_method_without_text_input_should_activate' "$mod_file"; then
    perl -0pi -e 's#                handle.add_instance\(&instance\);#                handle.add_instance(&instance);\n                if _state.input_method_without_text_input_should_activate() {\n                    handle.activate_input_method_without_text_input();\n                }#s' "$mod_file"
  fi
  if ! grep -q 'fn commit_string_without_text_input' "$mod_file"; then
    echo "patch-smithay-shell-osk: failed to patch $mod_file" >&2
    exit 1
  fi
  if ! grep -q 'activate_input_method_without_text_input' "$mod_file"; then
    echo "patch-smithay-shell-osk: failed to patch shell input-method seat helpers in $mod_file" >&2
    exit 1
  fi
  if ! grep -q 'input_method_without_text_input_should_activate' "$mod_file"; then
    echo "patch-smithay-shell-osk: failed to patch shell input-method activation predicate in $mod_file" >&2
    exit 1
  fi
  if ! grep -q 'pub(crate) fn activate_input_method_without_text_input' "$handle_file"; then
    echo "patch-smithay-shell-osk: failed to patch shell input-method activation in $handle_file" >&2
    exit 1
  fi
  if ! grep -q 'ContentPurpose::Normal' "$handle_file"; then
    echo "patch-smithay-shell-osk: failed to patch shell input-method activation state in $handle_file" >&2
    exit 1
  fi
  if ! grep -q 'committed_to_text_input' "$handle_file"; then
    echo "patch-smithay-shell-osk: failed to patch $handle_file" >&2
    exit 1
  fi
done

backend_files=()
while IFS= read -r file; do
  backend_files+=("$file")
done < <(find "$registry_root" -path '*/wayland-backend-0.3.15/src/sys/server_impl/mod.rs' -type f 2>/dev/null | sort)
if [[ ${#backend_files[@]} -eq 0 ]]; then
  echo "patch-smithay-shell-osk: wayland-backend 0.3.15 not found under $registry_root" >&2
  exit 1
fi
for backend_file in "${backend_files[@]}"; do
  if grep -q 'let client_id = unsafe { client_id_from_ptr(client) }.unwrap();' "$backend_file"; then
    perl -0pi -e 's#        let client_id = unsafe \{ client_id_from_ptr\(client\) \}\.unwrap\(\);\n#        let Some(client_id) = (unsafe { client_id_from_ptr(client) }) else {\n            return;\n        };\n#s' "$backend_file"
  fi
  if ! grep -q 'let Some(client_id) = (unsafe { client_id_from_ptr(client) }) else' "$backend_file"; then
    echo "patch-smithay-shell-osk: failed to patch wayland-backend post_error in $backend_file" >&2
    exit 1
  fi
done

find target -type f \( -name 'libsmithay-*.rlib' -o -name 'libsmithay-*.rmeta' -o -name 'smithay-*.d' \) -delete 2>/dev/null || true
find target -type d -path '*/.fingerprint/smithay-*' -prune -exec rm -rf {} + 2>/dev/null || true
find target -type f \( -name 'libwayland_backend-*.rlib' -o -name 'libwayland_backend-*.rmeta' -o -name 'wayland-backend-*.d' \) -delete 2>/dev/null || true
find target -type d -path '*/.fingerprint/wayland-backend-*' -prune -exec rm -rf {} + 2>/dev/null || true
