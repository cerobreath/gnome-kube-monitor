// Fake PanelMenu.Button. The real one initialises in _init, not a constructor,
// which is why this codebase forbids class fields in registerClass classes.

import {Actor} from '../actor.js';
import {PopupMenu} from './popupMenu.js';

export class Button extends Actor {
    /**
     * @param {number} [menuAlignment]
     * @param {string} [nameText]
     * @param {boolean} [dontCreateMenu]
     */
    _init(menuAlignment = 0.0, nameText = '', dontCreateMenu = false) {
        this.menuAlignment = menuAlignment;
        this.accessible_name = nameText;
        this.accessible_role = 'menu';
        this.menu = dontCreateMenu ? null : new PopupMenu(this);
        this.__initialised = true;
    }

    destroy() {
        this.menu?.destroy();
        super.destroy();
    }
}

export default {Button};
