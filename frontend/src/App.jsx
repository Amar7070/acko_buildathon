import { Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import ServicesPage from './pages/ServicesPage';
import ServiceDetailPage from './pages/ServiceDetailPage';
import MetricsPage from './pages/MetricsPage';
import ConsumersPage from './pages/ConsumersPage';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<ServicesPage />} />
        <Route path="services/:slug" element={<ServiceDetailPage />} />
        <Route path="consumers" element={<ConsumersPage />} />
        <Route path="metrics" element={<MetricsPage />} />
        <Route path="*" element={<ServicesPage />} />
      </Route>
    </Routes>
  );
}
