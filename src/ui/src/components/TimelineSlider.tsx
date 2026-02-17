import { Calendar } from 'lucide-react';

interface TimelineSliderProps {
  selectedDate: Date;
  onDateChange: (date: Date) => void;
}

// Generate quarterly dates for the timeline
const generateQuarterlyDates = () => {
  const dates: Date[] = [];
  const startDate = new Date('2024-01-01');
  const endDate = new Date('2027-12-31');
  
  let current = new Date(startDate);
  while (current <= endDate) {
    dates.push(new Date(current));
    current.setMonth(current.getMonth() + 3); // Add 3 months for quarterly
  }
  
  return dates;
};

export function TimelineSlider({ selectedDate, onDateChange }: TimelineSliderProps) {
  const dates = generateQuarterlyDates();
  const currentIndex = dates.findIndex(
    d => d.getTime() === selectedDate.getTime()
  ) || dates.findIndex(d => d >= selectedDate);

  const handleSliderChange = (index: number) => {
    onDateChange(dates[index]);
  };

  const formatQuarter = (date: Date) => {
    const quarter = Math.floor(date.getMonth() / 3) + 1;
    return `Q${quarter} ${date.getFullYear()}`;
  };

  return (
    <div className="mt-4 pt-4 border-t border-gray-200">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 flex-shrink-0">
          <Calendar className="w-4 h-4 text-gray-500" />
          <span className="text-sm font-medium text-gray-700">Timeline:</span>
        </div>
        
        <div className="flex-1 flex items-center gap-3">
          <span className="text-sm text-gray-600 flex-shrink-0">
            {formatQuarter(dates[0])}
          </span>
          
          <div className="flex-1 relative">
            <input
              type="range"
              min="0"
              max={dates.length - 1}
              value={currentIndex >= 0 ? currentIndex : 0}
              onChange={(e) => handleSliderChange(Number(e.target.value))}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
            />
            
            {/* Timeline markers */}
            <div className="absolute top-5 left-0 right-0 flex justify-between px-1 pointer-events-none">
              {dates.filter((_, i) => i % 4 === 0).map((date, i) => (
                <div key={i} className="text-xs text-gray-400">|</div>
              ))}
            </div>
          </div>
          
          <span className="text-sm text-gray-600 flex-shrink-0">
            {formatQuarter(dates[dates.length - 1])}
          </span>
        </div>
        
        <div className="bg-indigo-100 px-3 py-1 rounded-lg flex-shrink-0">
          <span className="text-sm font-semibold text-indigo-900">
            {formatQuarter(selectedDate)}
          </span>
        </div>
      </div>
      
      <p className="text-xs text-gray-500 mt-2 ml-6">
        View historical or projected ranking data across different time periods
      </p>
    </div>
  );
}
