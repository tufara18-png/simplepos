package ca.simplepos.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    {
        registerPlugin(MevKeystorePlugin.class);
        registerPlugin(MevProtocolPlugin.class);
        registerPlugin(PrinterBridgePlugin.class);
    }
}
